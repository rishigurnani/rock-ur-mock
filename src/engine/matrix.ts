// ============================================================================
// Pick Matrix resolver
// ----------------------------------------------------------------------------
// Turns a SPARSE set of cell overrides + a preset into a concrete, ordered
// list of picks. This one function generalizes Snake, Linear, 3rd-Round
// Reversal (paint round 3 in reverse via cell reassignment), traded picks
// (assignedTeamSlot), keepers (keeperPlayerId), and per-cell timers.
// ============================================================================

import type { MatrixCell, MatrixPreset, ResolvedPick } from '../types';

export type CellKey = `${number}:${number}`;

export function cellKey(round: number, teamSlot: number): CellKey {
  return `${round}:${teamSlot}`;
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
      picks.push({
        overall,
        round,
        teamSlot,
        owningTeamSlot: cell?.assignedTeamSlot ?? teamSlot,
        timerSeconds: cell?.timerSeconds ?? defaultTimerSeconds,
        keeperPlayerId: cell?.keeperPlayerId,
      });
    }
  }

  return picks;
}
