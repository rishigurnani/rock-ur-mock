// ============================================================================
// Pick Matrix resolver
// ----------------------------------------------------------------------------
// Turns a SPARSE set of cell overrides + a preset into a concrete, ordered
// list of picks. This one function generalizes Snake, Linear, 3rd-Round
// Reversal (paint round 3 in reverse via cell reassignment), traded picks
// (assignedTeamSlot), keepers (keeperPlayerId), and per-cell timers.
// ============================================================================

import type { KeeperOption, MatrixCell, MatrixPreset, ResolvedPick } from '../types';

export type CellKey = `${number}:${number}`;

export function cellKey(round: number, teamSlot: number): CellKey {
  return `${round}:${teamSlot}`;
}

/** The largest number of keeper picks any single team holds on the board. */
export function maxKeepersPerTeam(cells: Map<CellKey, MatrixCell>): number {
  const perTeam = new Map<number, number>();
  for (const c of cells.values()) {
    if (c.keepers?.length) perTeam.set(c.teamSlot, (perTeam.get(c.teamSlot) ?? 0) + 1);
  }
  return Math.max(0, ...perTeam.values());
}

export interface ResolveOptions {
  teamCount: number;
  roundCount: number;
  preset: MatrixPreset;
  defaultTimerSeconds: number;
  /** Sparse overrides keyed by `${round}:${teamSlot}`. */
  cells?: Map<CellKey, MatrixCell>;
}

/** The order teamSlots pick in for a given round under the base preset. */
function slotOrderForRound(
  round: number,
  teamCount: number,
  preset: MatrixPreset,
): number[] {
  const ascending = Array.from({ length: teamCount }, (_, i) => i + 1);
  if (preset === 'linear') return ascending;
  // Snake: even rounds (1-indexed) reverse.
  return round % 2 === 0 ? ascending.slice().reverse() : ascending;
}

/**
 * Resolve the full ordered pick list. Deterministic and pure.
 */
export function resolvePickOrder(opts: ResolveOptions): ResolvedPick[] {
  const { teamCount, roundCount, preset, defaultTimerSeconds } = opts;
  const cells = opts.cells ?? new Map<CellKey, MatrixCell>();
  const picks: ResolvedPick[] = [];
  let overall = 0;

  for (let round = 1; round <= roundCount; round++) {
    const order = slotOrderForRound(round, teamCount, preset);
    for (const teamSlot of order) {
      overall += 1;
      const cell = cells.get(cellKey(round, teamSlot));
      const keepers = cell?.keepers;
      picks.push({
        overall,
        round,
        teamSlot,
        owningTeamSlot: cell?.assignedTeamSlot ?? teamSlot,
        timerSeconds: cell?.timerSeconds ?? defaultTimerSeconds,
        // A single candidate resolves to a locked occupant (shown live and in
        // preview); multiple candidates stay unresolved until the run is rolled.
        keeperPlayerId: keepers?.length === 1 ? keepers[0].playerId : undefined,
        keepers,
      });
    }
  }

  return picks;
}

/** Cumulative single-roll selection among a cell's candidates: each occupies a
 *  slice of [0,1) sized by its prob, and `r` lands in one — or in the leftover
 *  "nobody kept" gap. Order-stable, so a seeded draft is reproducible. */
function pickWinner(options: KeeperOption[], r: number): KeeperOption | null {
  let acc = 0;
  for (const o of options) {
    acc += o.prob;
    if (r < acc) return o;
  }
  return null;
}

/**
 * Resolve which candidate (if any) each keeper cell keeps THIS run, reducing the
 * cell to its single winner. A lone certain candidate (prob ≥ 1) never rolls — so
 * seeded drafts with only fixed keepers are unchanged. Pure: no mutation.
 */
export function rollKeepers(
  cells: Map<CellKey, MatrixCell>,
  rng: () => number,
): Map<CellKey, MatrixCell> {
  const out = new Map<CellKey, MatrixCell>();
  for (const [key, cell] of cells) {
    const options = cell.keepers;
    if (!options?.length || (options.length === 1 && options[0].prob >= 1)) {
      out.set(key, cell);
      continue;
    }
    const winner = pickWinner(options, rng());
    const { keepers: _drop, ...rest } = cell;
    out.set(key, winner ? { ...rest, keepers: [winner] } : rest);
  }
  return out;
}
