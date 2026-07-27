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
  Team,
} from '../types';
import { applyModifiers, EffectivePlayer } from './modifiers';
import { resolvePickOrder, rollKeepers, keptPlayerId, draftHorizon, CellKey } from './matrix';
import type { MatrixCell } from '../types';
import { scoreCandidates, PRESETS, Rng, ScoredCandidate } from './bot';
import { RosterState } from './roster';

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
  private readonly forced = new Map<number, { playerId: string; trace: CompletedPick['trace'] }>(); // heisted players (+ the victim bot's read on them) pinned to a pick, re-applied on any rewind

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

  /** Players pinned live but not yet drafted — reserved exactly like keepers: held
   *  out of the pool so nobody scoops them, and counted onto their owner's roster
   *  from the moment the pin is set. Pass `slot` to get just that team's pins.
   *  (Heisted pins commit at once, so they're never available and never listed.) */
  private pins(slot?: number): string[] {
    const out: string[] = [];
    for (const [o, f] of this.forced)
      if (this.available.has(f.playerId) && (slot == null || this.order[o - 1]?.owningTeamSlot === slot)) out.push(f.playerId);
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
    const pinned = new Set(this.pins());
    return [...this.available.values()].filter((p) => !pinned.has(p.id));
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

    // Keeper: locked player (reserved out of the pool), no bot logic.
    const kept = keptPlayerId(pick);
    if (kept) {
      const keeper = this.byId.get(kept);
      if (keeper) return this.commit(pick, keeper, undefined);
      // Keeper id not in dataset (e.g. stale) — fall through to auto-pick.
    }

    const forced = this.forced.get(pick.overall);
    if (forced && this.available.has(forced.playerId)) return this.commit(pick, this.available.get(forced.playerId)!, forced.trace);
    if (pick.owningTeamSlot === this.humanSlot) return null;

    const team = this.teamsBySlot.get(pick.owningTeamSlot);
    if (!team) throw new Error(`No team at slot ${pick.owningTeamSlot}`);
    return this.botPick(pick, team);
  }

  /** Hand the human's own pick to the CPU, using the sharp bot brain. */
  autoPickHuman(): CompletedPick | null {
    const pick = this.currentPick;
    if (!pick || !this.isHumanOnClock) return null;
    const team = this.teamsBySlot.get(pick.owningTeamSlot)!;
    return this.botPick(pick, { ...team, brain: PRESETS.sharp });
  }

  /** The bot brain's shortlist for `pick` on the current pool, sorted best-first. */
  private scoreFor(pick: ResolvedPick, team: Team): ScoredCandidate[] {
    const { picksLeft, untilNext } = draftHorizon(this.order, this.cursor, pick.owningTeamSlot);
    const rosterPlayers = this.teamPlayerIds(pick.owningTeamSlot)
      .map((id) => this.byId.get(id))
      .filter((p): p is EffectivePlayer => !!p);
    return scoreCandidates(team.brain, {
      available: this.availablePlayers(),
      rosterPlayers,
      config: this.config,
      modifiers: this.modifiers,
      totalPlayerPool: this.effective.length,
      currentPick: pick.overall,
      picksLeft,
      picksUntilNext: untilNext,
      rng: this.rng,
    });
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
    const trace = hit.shortlist?.find((s) => s.playerId === mine.playerId)?.trace; // the victim's own read on him
    this.force(hit.overall, mine.playerId, trace); // pin it (+ trace); rewinds so any later rewind re-applies it
    this.runToCompletion();
    return true;
  }

  /** Pin `playerId` to pick `overall` and rewind there so the re-run commits it —
   *  the shared mechanism behind the heist and a manual "fix to this slot" (re-applies
   *  on any later rewind). Caller runs the board forward afterward. */
  force(overall: number, playerId: string, trace?: CompletedPick['trace']): void {
    this.forced.set(overall, { playerId, trace });
    this.rewindTo(overall);
  }

  /** The overall pick a team owns in a round (null if it owns none — e.g. traded). */
  pickAt(round: number, teamSlot: number): number | null {
    return this.order.find((p) => p.round === round && p.owningTeamSlot === teamSlot)?.overall ?? null;
  }

  /** A player force-pinned to `overall` but not yet drafted there — the pending pin
   *  the board previews before the slot is reached (null once committed, so a
   *  heisted pick never shows as pending). */
  pinnedAt(overall: number): string | null {
    const f = this.forced.get(overall);
    return f && this.available.has(f.playerId) ? f.playerId : null;
  }

  /** The LATEST bot pick since your last ON-THE-CLOCK turn whose top-15 board held
   *  `mine`'s player — the seat the heist steals him back from (null if none).
   *  Keepers auto-recommit on rewind, so they aren't a turn and never bound it. */
  private findHeistVictim(mine: CompletedPick): CompletedPick | null {
    const myTurn = (c: CompletedPick) => c.teamSlot === this.humanSlot && !keptPlayerId(this.order[c.overall - 1]);
    const priors = this.completed.filter((c) => c.overall < mine.overall);
    const sinceMyTurn = priors.slice(priors.map(myTurn).lastIndexOf(true) + 1);
    return sinceMyTurn.filter((c) => c.shortlist?.some((s) => s.playerId === mine.playerId)).at(-1) ?? null;
  }

  /** Rewind so `overall` is back on the clock: undo every pick at or after it,
   *  returning drafted players to the pool (reserved keepers stay reserved).
   *  A no-op if nothing at/after `overall` has been committed. */
  rewindTo(overall: number): void {
    while (this.completed.length && this.completed[this.completed.length - 1].overall >= overall) {
      const undone = this.completed.pop()!;
      const player = this.byId.get(undone.playerId);
      if (player && !keptPlayerId(this.order[undone.overall - 1])) this.available.set(player.id, player);
    }
    this.cursor = this.completed.length;
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
