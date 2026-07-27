// ============================================================================
// Draft engine — the orchestrator.
// ----------------------------------------------------------------------------
// Holds live draft state and advances pick-by-pick. Bots pick via scoreCandidates;
// a human seat picks via makePick(). Keeper cells auto-lock their player.
// Pure-ish: all randomness flows through an injectable RNG.
// ============================================================================

import type {
  CompletedPick,
  LeagueConfig,
  Modifier,
  Player,
  Position,
  ResolvedPick,
  ScoreTrace,
  Team,
} from '../types';
import { applyModifiers, EffectivePlayer } from './modifiers';
import { resolvePickOrder, rollKeepers, keptPlayerId, draftHorizon, CellKey } from './matrix';
import type { MatrixCell } from '../types';
import { scoreCandidates, PRESETS, Rng, ScoredCandidate } from './bot';
import { RosterState } from './roster';

/** One scoring context: the roster and pool a board is judged against, the horizon
 *  cursor, and the RNG (live for a real pick, flat for a hypothetical re-score). */
interface ScoreCtx { roster: EffectivePlayer[]; available: EffectivePlayer[]; cursor: number; rng: Rng }

export interface DraftSetup {
  players: Player[];
  modifiers: Modifier[];
  teams: Team[];
  config: LeagueConfig;
  cells?: Map<CellKey, MatrixCell>;
  defaultTimerSeconds?: number;
  rng?: Rng;
  /** Slot of the human seat, if any. Null => fully autonomous sim. */
  humanSlot?: number | null;
}

export class DraftEngine {
  readonly order: ResolvedPick[];
  readonly config: LeagueConfig;
  private readonly teamsBySlot = new Map<number, Team>();
  private readonly modifiers: Modifier[];
  private readonly rng: Rng;
  private readonly humanSlot: number | null;

  private effective: EffectivePlayer[];
  private readonly byId = new Map<string, EffectivePlayer>();
  private available = new Map<string, EffectivePlayer>();
  // Reserved keepers grouped by owning team — pre-committed roster members that
  // count from the very first pick, even before their cell is reached.
  private readonly keepersBySlot = new Map<number, string[]>();

  cursor = 0;
  readonly completed: CompletedPick[] = [];
  lastHeist: { playerId: string; teamSlot: number } | null = null; // set by heist(), for the UI notice
  // Players pinned to a pick. `heist` marks a time-machine steal vs a manual user pin:
  // a heist's trace is recomputed honestly at commit and it's undone by a user rewind,
  // whereas a user pin persists and previews/counts on the board as a pending pin.
  private readonly forced = new Map<number, { playerId: string; heist?: boolean }>();

  constructor(setup: DraftSetup) {
    this.config = setup.config;
    this.modifiers = setup.modifiers;
    this.rng = setup.rng ?? Math.random;
    this.humanSlot = setup.humanSlot ?? null;

    for (const t of setup.teams) this.teamsBySlot.set(t.slot, t);

    this.effective = applyModifiers(setup.players, setup.modifiers);
    for (const p of this.effective) {
      this.byId.set(p.id, p);
      this.available.set(p.id, p);
    }

    // Roll probabilistic keepers ONCE per build (seeded), then treat the
    // survivors as ordinary locked keepers everywhere downstream.
    const cells = setup.cells ? rollKeepers(setup.cells, this.rng, setup.config.keeperCount) : undefined;
    this.order = resolvePickOrder({
      teamCount: setup.config.teamCount,
      roundCount: setup.config.roundCount,
      preset: setup.config.preset,
      defaultTimerSeconds: setup.defaultTimerSeconds ?? 60,
      cells,
    });
    this.reserveKeepers();
  }

  /** Lock kept players out of the pool and group them by owning team, so a keeper
   *  counts toward its roster from pick #1 (before its cell is reached). Reads only
   *  the resolved order: rollKeepers has already reduced each cell to its single
   *  winner, which keptPlayerId reads off the pick's candidate list. */
  private reserveKeepers() {
    for (const pick of this.order) {
      const kept = keptPlayerId(pick);
      if (!kept) continue;
      this.available.delete(kept);
      const arr = this.keepersBySlot.get(pick.owningTeamSlot) ?? [];
      arr.push(kept);
      this.keepersBySlot.set(pick.owningTeamSlot, arr);
    }
  }

  /** A team's roster = its completed picks + its not-yet-reached keepers and pins. */
  teamPlayerIds(slot: number): string[] {
    const done = this.completed.filter((c) => c.teamSlot === slot).map((c) => c.playerId);
    const have = new Set(done);
    const reserved = [...(this.keepersBySlot.get(slot) ?? []), ...this.pins(slot)];
    return [...done, ...reserved.filter((id) => !have.has(id))];
  }

  /** USER-pinned (not heisted) players not yet drafted — counted onto their owner's
   *  roster from the moment the pin is set, exactly like a keeper. Pass `slot` for
   *  one team's pins. Heists are excluded: a steal counts only once truly committed. */
  private pins(slot?: number): string[] {
    const out: string[] = [];
    for (const [o, f] of this.forced) {
      if (f.heist || !this.available.has(f.playerId)) continue; // heists & committed players aren't pending pins
      if (slot == null || this.order[o - 1]?.owningTeamSlot === slot) out.push(f.playerId);
    }
    return out;
  }

  private countsFor(slot: number): Record<Position, number> {
    const counts: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    for (const id of this.teamPlayerIds(slot)) {
      const p = this.byId.get(id);
      if (p) counts[p.position] += 1;
    }
    return counts;
  }

  get isComplete(): boolean {
    return this.cursor >= this.order.length;
  }

  get currentPick(): ResolvedPick | null {
    return this.order[this.cursor] ?? null;
  }

  /** Whose turn it is. A pick the human owns but has force-pinned is predetermined
   *  (engine resolves it, same condition step() commits under) — so it reads as NOT
   *  the human's, keeping the pin safe from autoPickHuman / a manual draft there. */
  get isHumanOnClock(): boolean {
    const pick = this.currentPick;
    if (!pick || pick.owningTeamSlot !== this.humanSlot) return false;
    const f = this.forced.get(pick.overall);
    return !(f && this.available.has(f.playerId));
  }

  availablePlayers(): EffectivePlayer[] {
    // Hold any not-yet-drafted forced player — a live user pin OR a heist awaiting
    // its re-run after a rewind — out of the pool, so nobody scoops them first.
    const reserved = new Set<string>();
    for (const [, f] of this.forced) if (this.available.has(f.playerId)) reserved.add(f.playerId);
    return [...this.available.values()].filter((p) => !reserved.has(p.id));
  }

  rosterFor(slot: number): RosterState {
    return { counts: this.countsFor(slot) };
  }

  /** Commit a specific player to the current pick (human seat or forced). */
  makePick(playerId: string): CompletedPick {
    const pick = this.currentPick;
    if (!pick) throw new Error('Draft is complete');
    const player = this.available.get(playerId);
    if (!player) throw new Error(`Player ${playerId} is not available`);
    return this.commit(pick, player, undefined);
  }

  /**
   * Advance one pick. Auto-resolves keepers and bots. If a human is on the
   * clock, returns null and waits for makePick().
   */
  step(): CompletedPick | null {
    const pick = this.currentPick;
    if (!pick) return null;
    const predetermined = this.commitKeeper(pick) ?? this.commitForced(pick);
    if (predetermined) return predetermined;
    if (pick.owningTeamSlot === this.humanSlot) return null; // human's free choice — wait for makePick
    const team = this.teamsBySlot.get(pick.owningTeamSlot);
    if (!team) throw new Error(`No team at slot ${pick.owningTeamSlot}`);
    return this.botPick(pick, team);
  }

  /** The locked keeper at `pick`, committed — or null if it isn't a resolvable keeper
   *  (a stale keeper id falls through to an auto-pick). */
  private commitKeeper(pick: ResolvedPick): CompletedPick | null {
    const kept = keptPlayerId(pick);
    const keeper = kept ? this.byId.get(kept) : undefined;
    return keeper ? this.commit(pick, keeper, undefined) : null;
  }

  /** The forced player (a heist or a user pin) at `pick`, committed — or null if none
   *  is pending. A steal's trace is re-scored honestly at commit; a user pin has none. */
  private commitForced(pick: ResolvedPick): CompletedPick | null {
    const forced = this.forced.get(pick.overall);
    if (!forced || !this.available.has(forced.playerId)) return null;
    const player = this.available.get(forced.playerId)!;
    return this.commit(pick, player, forced.heist ? this.freshTrace(pick, player) : undefined);
  }

  /** Hand the human's own pick to the CPU, using the sharp bot brain. */
  autoPickHuman(): CompletedPick | null {
    const pick = this.currentPick;
    if (!pick || !this.isHumanOnClock) return null;
    const team = this.teamsBySlot.get(pick.owningTeamSlot)!;
    return this.botPick(pick, { ...team, brain: PRESETS.sharp });
  }

  /** This team's roster as EffectivePlayers, optionally dropping one id (the pick a
   *  heist would replace — the steal is judged against what the team would KEEP). */
  private rosterOf(slot: number, exclude?: string): EffectivePlayer[] {
    return this.teamPlayerIds(slot)
      .filter((id) => id !== exclude)
      .map((id) => this.byId.get(id))
      .filter((p): p is EffectivePlayer => !!p);
  }

  /** Core scoring: `team`'s ranked board for `pick` under one scoring context. `rng` is
   *  the live one for a real pick, a flat 0.5 for a hypothetical (a heist re-score) so
   *  the what-if never perturbs the actual draft. */
  private score(pick: ResolvedPick, team: Team, ctx: ScoreCtx): ScoredCandidate[] {
    const { picksLeft, untilNext } = draftHorizon(this.order, ctx.cursor, pick.owningTeamSlot);
    return scoreCandidates(team.brain, {
      available: ctx.available, rosterPlayers: ctx.roster, config: this.config, modifiers: this.modifiers,
      totalPlayerPool: this.effective.length, currentPick: pick.overall,
      picksLeft, picksUntilNext: untilNext, rng: ctx.rng,
    });
  }

  /** The bot brain's shortlist for `pick` on the live board, sorted best-first. */
  private scoreFor(pick: ResolvedPick, team: Team): ScoredCandidate[] {
    return this.score(pick, team, { roster: this.rosterOf(pick.owningTeamSlot), available: this.availablePlayers(), cursor: this.cursor, rng: this.rng });
  }

  /** The victim bot's OWN read on a stolen player, scored at commit against its roster
   *  as of this pick (the reserved player added back into the running pool). */
  private freshTrace(pick: ResolvedPick, player: EffectivePlayer): ScoreTrace | undefined {
    const team = this.teamsBySlot.get(pick.owningTeamSlot);
    if (!team) return undefined;
    return this.score(pick, team, { roster: this.rosterOf(pick.owningTeamSlot), available: [player, ...this.availablePlayers()], cursor: this.cursor, rng: this.rng })
      .find((s) => s.player.id === player.id)?.trace;
  }

  /** Would the bot at `c` still rank `playerId` in its top 15 if re-scored NOW against
   *  its live roster (minus that pick's own player)? A steal only lands where the
   *  victim genuinely wants him, so a player a bot already covers falls out and the
   *  search moves on — no chaos (flat rng), and never onto an existing pin/steal. */
  private wouldShortlist(c: CompletedPick, playerId: string): boolean {
    const team = this.teamsBySlot.get(c.teamSlot);
    const player = this.byId.get(playerId);
    if (!team || !player) return false;
    const scored = this.score(this.order[c.overall - 1], team, { roster: this.rosterOf(c.teamSlot, c.playerId), available: [player, ...this.availablePlayers()], cursor: c.overall - 1, rng: () => 0.5 });
    return scored.slice(0, 15).some((s) => s.player.id === playerId);
  }

  /** Score the bot's options for `pick` and commit its choice. */
  private botPick(pick: ResolvedPick, team: Team): CompletedPick {
    const scored = this.scoreFor(pick, team);
    const choice = scored[0];
    if (!choice) throw new Error('No legal pick available');
    return Object.assign(this.commit(pick, choice.player, choice.trace), { shortlist: scored.slice(0, 15).map((c) => ({ playerId: c.player.id, trace: c.trace })) });
  }

  // Time machine (odds `chance`): rewind, giving the player you drafted to the LATEST bot since your last turn with him in its top 15, so you pick again. True if heisted.
  heist(chance: number): boolean {
    this.lastHeist = null;
    const mine = this.completed.at(-1);
    if (!mine || mine.teamSlot !== this.humanSlot || this.rng() >= chance) return false;
    const hit = this.findHeistVictim(mine);
    if (!hit) return false;
    this.lastHeist = { playerId: mine.playerId, teamSlot: hit.teamSlot };
    this.force(hit.overall, mine.playerId, { heist: true }); // its trace is re-scored honestly at commit
    this.runToCompletion();
    return true;
  }

  /** Pin `playerId` to pick `overall` and rewind there so the re-run commits it — the
   *  shared mechanism behind a manual "fix to this slot" and (with `heist`) the time
   *  machine. A pin persists across rewinds; a heist is undone by a user's rewind. */
  force(overall: number, playerId: string, opts?: { heist?: boolean }): void {
    this.forced.set(overall, { playerId, heist: opts?.heist });
    this.rewindTo(overall);
  }

  /** The overall pick a team owns in a round (null if it owns none — e.g. traded). */
  pickAt(round: number, teamSlot: number): number | null {
    return this.order.find((p) => p.round === round && p.owningTeamSlot === teamSlot)?.overall ?? null;
  }

  /** A player USER-pinned to `overall` but not yet drafted there — the pending pin
   *  the board previews before the slot is reached (null once committed). A heist is
   *  excluded: a rewound-but-not-yet-recommitted steal is not a user pin. */
  pinnedAt(overall: number): string | null {
    const f = this.forced.get(overall);
    return f && !f.heist && this.available.has(f.playerId) ? f.playerId : null;
  }

  /** The LATEST bot pick since your last ON-THE-CLOCK turn that — RE-SCORED against
   *  its current roster — still wants `mine`'s player, walking backward one slot at a
   *  time until one does (null if none reaches your last turn). Re-scoring is what makes
   *  a redundant steal (a 2nd QB) fall out and relocate to a bot that truly needs him,
   *  so two of a position land together only in the rare case a bot ranks him anyway. */
  private findHeistVictim(mine: CompletedPick): CompletedPick | null {
    const myTurn = (c: CompletedPick) => c.teamSlot === this.humanSlot && !keptPlayerId(this.order[c.overall - 1]);
    const priors = this.completed.filter((c) => c.overall < mine.overall);
    const sinceMyTurn = priors.slice(priors.map(myTurn).lastIndexOf(true) + 1);
    for (let i = sinceMyTurn.length - 1; i >= 0; i--) {
      const c = sinceMyTurn[i]; // a shortlist marks a real bot pick — never a keeper, pin or prior steal (unstealable)
      if (c.shortlist && this.wouldShortlist(c, mine.playerId)) return c;
    }
    return null;
  }

  /** Rewind so `overall` is back on the clock: undo every pick at or after it,
   *  returning drafted players to the pool (reserved keepers stay reserved). With
   *  `clearHeists`, a USER rewind also drops any steal at/after `overall` — the stolen
   *  player goes back to the pool for good, not re-taken. A no-op if nothing to undo. */
  rewindTo(overall: number, clearHeists = false): void {
    while (this.completed.length && this.completed[this.completed.length - 1].overall >= overall) {
      this.returnToPool(this.completed.pop()!);
    }
    this.cursor = this.completed.length;
    if (clearHeists) this.dropHeistsFrom(overall);
  }

  /** Undo `done`, returning its drafted player to the pool (a reserved keeper stays out). */
  private returnToPool(done: CompletedPick): void {
    const player = this.byId.get(done.playerId);
    if (player && !keptPlayerId(this.order[done.overall - 1])) this.available.set(player.id, player);
  }

  /** Drop every steal pinned at or after `overall` (a user rewind un-steals them). */
  private dropHeistsFrom(overall: number): void {
    for (const [o, f] of this.forced) if (o >= overall && f.heist) this.forced.delete(o);
  }

  /** Run every remaining pick that isn't gated on the human seat. */
  runToCompletion(): void {
    while (!this.isComplete) {
      const result = this.step();
      if (result === null) break; // human on the clock
    }
  }

  private commit(
    pick: ResolvedPick,
    player: EffectivePlayer,
    trace: CompletedPick['trace'],
  ): CompletedPick {
    this.available.delete(player.id);

    const done: CompletedPick = {
      overall: pick.overall,
      round: pick.round,
      teamSlot: pick.owningTeamSlot,
      playerId: player.id,
      trace,
    };
    this.completed.push(done);
    this.cursor += 1;
    return done;
  }
}

export type { Player };
