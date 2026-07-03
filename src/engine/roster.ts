// ============================================================================
// Roster tracking — how many starters a team still needs, per position.
// Feeds the bot's "Roster Needs" slider and enforces roster_max caps.
// ============================================================================

import type { LeagueConfig, Player, Position, RosterSlot } from '../types';

const FLEX_ELIGIBLE: Position[] = ['RB', 'WR', 'TE'];

// Order in which starting slots are filled by the lineup optimizer.
const STARTER_SLOTS: RosterSlot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];

export interface RosterState {
  /** Players drafted, by position. */
  counts: Record<Position, number>;
}

export function emptyRoster(): RosterState {
  return { counts: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 } };
}

export function addToRoster(state: RosterState, pos: Position): RosterState {
  return { counts: { ...state.counts, [pos]: state.counts[pos] + 1 } };
}

/**
 * Does drafting `pos` fill a still-empty STARTING slot (dedicated or FLEX)?
 * This is the signal behind the roster-need bonus.
 */
export function fillsStartingSlot(
  state: RosterState,
  pos: Position,
  config: LeagueConfig,
): boolean {
  const slots = config.rosterSlots;
  const have = state.counts[pos];

  // 1. Dedicated starting slot at this position still open?
  const dedicated = slots[pos] ?? 0;
  if (have < dedicated) return true;

  // 2. Otherwise, is there an open FLEX slot this position can fill?
  if (!FLEX_ELIGIBLE.includes(pos)) return false;
  const flexSlots = slots.FLEX ?? 0;
  if (flexSlots === 0) return false;

  // FLEX is open if flex-eligible players beyond their dedicated slots < FLEX.
  let flexUsed = 0;
  for (const fp of FLEX_ELIGIBLE) {
    const overflow = state.counts[fp] - (slots[fp] ?? 0);
    if (overflow > 0) flexUsed += overflow;
  }
  return flexUsed < flexSlots;
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
 * How many starting slots are still empty, from position counts alone (no
 * player objects needed). Drives the bots' end-of-draft urgency to fill scarce
 * mandatory positions like K and DST.
 */
export function unfilledStarterCount(
  counts: Record<Position, number>,
  slots: Partial<Record<RosterSlot, number>>,
): number {
  let unfilled = 0;
  let flexOverflow = 0;
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as Position[]) {
    const need = slots[pos] ?? 0;
    if (counts[pos] < need) unfilled += need - counts[pos];
    else if (FLEX_ELIGIBLE.includes(pos)) flexOverflow += counts[pos] - need;
  }
  const flex = slots.FLEX ?? 0;
  return unfilled + Math.max(0, flex - flexOverflow);
}
