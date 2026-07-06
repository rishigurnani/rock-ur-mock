// ============================================================================
// Draft engine — the orchestrator.
// ----------------------------------------------------------------------------
// Holds live draft state and advances pick-by-pick. Bots pick via selectPick;
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
import { resolvePickOrder, rollKeepers, CellKey } from './matrix';
import type { MatrixCell } from '../types';
import { selectPick, Rng } from './bot';
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
    const cells = setup.cells ? rollKeepers(setup.cells, this.rng) : undefined;
    this.order = resolvePickOrder({
      teamCount: setup.config.teamCount,
      roundCount: setup.config.roundCount,
      preset: setup.config.preset,
      defaultTimerSeconds: setup.defaultTimerSeconds ?? 60,
      cells,
    });
    this.reserveKeepers(cells);
  }

  /** Lock kept players out of the pool and group them by their owning team, so
   *  a keeper counts toward its roster from pick #1 (before its cell is reached). */
  private reserveKeepers(cells?: Map<CellKey, MatrixCell>) {
    if (cells) {
      // Rolled cells carry their single resolved winner in keepers[0].
      for (const cell of cells.values()) {
        const kept = cell.keepers?.[0]?.playerId;
        if (kept) this.available.delete(kept);
      }
    }
    for (const pick of this.order) {
      if (!pick.keeperPlayerId) continue;
      const arr = this.keepersBySlot.get(pick.owningTeamSlot) ?? [];
      arr.push(pick.keeperPlayerId);
      this.keepersBySlot.set(pick.owningTeamSlot, arr);
    }
  }

  /** A team's roster = its completed picks + its not-yet-reached keepers. */
  teamPlayerIds(slot: number): string[] {
    const done = this.completed.filter((c) => c.teamSlot === slot).map((c) => c.playerId);
    const have = new Set(done);
    const keepers = (this.keepersBySlot.get(slot) ?? []).filter((id) => !have.has(id));
    return [...done, ...keepers];
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

  /** Whose turn it is, and whether the engine expects a human to act. */
  get isHumanOnClock(): boolean {
    const pick = this.currentPick;
    return pick != null && pick.owningTeamSlot === this.humanSlot;
  }

  availablePlayers(): EffectivePlayer[] {
    return [...this.available.values()];
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
    if (pick.keeperPlayerId) {
      const keeper = this.byId.get(pick.keeperPlayerId);
      if (keeper) return this.commit(pick, keeper, undefined);
      // Keeper id not in dataset (e.g. stale) — fall through to auto-pick.
    }

    if (pick.owningTeamSlot === this.humanSlot) return null;

    const team = this.teamsBySlot.get(pick.owningTeamSlot);
    if (!team) throw new Error(`No team at slot ${pick.owningTeamSlot}`);
    return this.botPick(pick, team);
  }

  /** Score the bot's options for `pick` and commit its choice. */
  private botPick(pick: ResolvedPick, team: Team): CompletedPick {
    let picksLeft = 0;
    for (let i = this.cursor; i < this.order.length; i++) {
      if (this.order[i].owningTeamSlot === pick.owningTeamSlot) picksLeft++;
    }

    const rosterPlayers = this.teamPlayerIds(pick.owningTeamSlot)
      .map((id) => this.byId.get(id))
      .filter((p): p is EffectivePlayer => !!p);
    const choice = selectPick(team.brain, {
      available: this.availablePlayers(),
      rosterPlayers,
      config: this.config,
      modifiers: this.modifiers,
      totalPlayerPool: this.effective.length,
      currentPick: pick.overall,
      picksLeft,
      rng: this.rng,
    });
    if (!choice) throw new Error('No legal pick available');
    return this.commit(pick, choice.player, choice.trace);
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
