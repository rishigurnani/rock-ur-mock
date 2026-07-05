// ============================================================================
// Roster tracking — how many starters a team still needs, per position.
// Feeds the bot's "Roster Needs" slider and enforces roster_max caps.
// ============================================================================

import type { Player, Position, RosterSlot } from '../types';

const FLEX_ELIGIBLE: Position[] = ['RB', 'WR', 'TE'];

// Order in which starting slots are filled by the lineup optimizer.
const STARTER_SLOTS: RosterSlot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];

export interface RosterState {
  /** Players drafted, by position. */
  counts: Record<Position, number>;
}

// ---------------------------------------------------------------------------
// Lineup engine — one primitive behind two features: the starters/bench view
// AND the bots' roster-completion urgency. Greedily seats the best projected
// player in each starting slot (FLEX from the best leftover RB/WR/TE), the rest
// go to the bench, and any seat left empty is a still-needed starter.
// ---------------------------------------------------------------------------

export interface LineupSeat {
  slot: RosterSlot;
  player: Player | null;
}
export interface Lineup {
  starters: LineupSeat[];
  bench: Player[];
  startingPoints: number;
  /** Starting slots with no player yet — the team's true remaining needs. */
  unfilled: RosterSlot[];
}

export function optimizeLineup(
  players: Player[],
  slots: Partial<Record<RosterSlot, number>>,
): Lineup {
  const pool = [...players].sort((a, b) => b.projPoints - a.projPoints);
  const used = new Set<string>();
  const take = (ok: (p: Player) => boolean): Player | null => {
    const p = pool.find((x) => !used.has(x.id) && ok(x));
    if (p) used.add(p.id);
    return p ?? null;
  };

  const starters: LineupSeat[] = [];
  for (const slot of STARTER_SLOTS) {
    for (let i = 0; i < (slots[slot] ?? 0); i++) {
      const player =
        slot === 'FLEX'
          ? take((x) => FLEX_ELIGIBLE.includes(x.position))
          : take((x) => x.position === slot);
      starters.push({ slot, player });
    }
  }

  return {
    starters,
    bench: pool.filter((x) => !used.has(x.id)),
    startingPoints: starters.reduce((s, seat) => s + (seat.player?.projPoints ?? 0), 0),
    unfilled: starters.filter((seat) => !seat.player).map((seat) => seat.slot),
  };
}

/**
 * Marginal starting-lineup value of adding `candidate` to `roster`: the gain in
 * optimized starting points. Zero for pure bench depth (a redundant player who
 * can't crack the lineup), positive when the candidate fills an empty slot OR
 * upgrades a weak starter.
 *
 * This is the quality-aware replacement for count-based positional need: it
 * still wants a starting-caliber RB even when the roster already holds three
 * bench-caliber RBs (e.g. keepers), and it ignores a scrub who would only ride
 * the bench — something raw position counts can never see.
 */
export function marginalStartingValue(
  roster: Player[],
  candidate: Player,
  slots: Partial<Record<RosterSlot, number>>,
  baseStartingValue = optimizeLineup(roster, slots).startingPoints,
): number {
  const withCandidate = optimizeLineup([...roster, candidate], slots).startingPoints;
  return Math.max(0, withCandidate - baseStartingValue);
}

/**
 * Bye weeks on which two or more of the given players (typically a team's
 * starters) all sit out at once — the signal behind bye-stack warnings. Returns
 * `{ week, count }` for each clashing week, worst (most stacked) first.
 */
export function byeClashes(players: Player[]): { week: number; count: number }[] {
  const byWeek = new Map<number, number>();
  for (const p of players) {
    if (p.bye) byWeek.set(p.bye, (byWeek.get(p.bye) ?? 0) + 1);
  }
  return [...byWeek.entries()]
    .filter(([, count]) => count >= 2)
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => b.count - a.count);
}
