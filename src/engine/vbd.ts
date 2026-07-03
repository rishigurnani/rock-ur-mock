// ============================================================================
// Value Based Drafting (VBD)
// ----------------------------------------------------------------------------
// VBD = a player's projected points above the "replacement level" at their
// position. Replacement level is the projection of the last starter-worthy
// player at that position across the whole league. Recomputed per pick because
// the baseline shifts as players come off the board.
// ============================================================================

import type { LeagueConfig, Position, RosterSlot } from '../types';
import type { EffectivePlayer } from './modifiers';

const FLEX_POSITIONS: Position[] = ['RB', 'WR', 'TE'];

/**
 * How many starters the league demands at each position, folding a share of
 * FLEX slots into the flex-eligible positions. Used to locate the replacement
 * baseline (roughly: starters + one bench cushion).
 */
function starterDemand(config: LeagueConfig): Record<Position, number> {
  const slots = config.rosterSlots;
  const demand: Record<Position, number> = {
    QB: (slots.QB ?? 0) * config.teamCount,
    RB: (slots.RB ?? 0) * config.teamCount,
    WR: (slots.WR ?? 0) * config.teamCount,
    TE: (slots.TE ?? 0) * config.teamCount,
    K: (slots.K ?? 0) * config.teamCount,
    DST: (slots.DST ?? 0) * config.teamCount,
  };
  // Distribute FLEX evenly across flex-eligible positions.
  const flex = (slots.FLEX ?? 0) * config.teamCount;
  const perPos = Math.round(flex / FLEX_POSITIONS.length);
  for (const pos of FLEX_POSITIONS) demand[pos] += perPos;
  return demand;
}

/**
 * Compute the replacement-level projection for each position from the CURRENT
 * available pool. Baseline index = starter demand (so the "next man up").
 */
export function computeBaselines(
  available: EffectivePlayer[],
  config: LeagueConfig,
): Record<Position, number> {
  const demand = starterDemand(config);
  const byPos = new Map<Position, number[]>();
  for (const p of available) {
    const arr = byPos.get(p.position) ?? [];
    arr.push(p.effProjPoints);
    byPos.set(p.position, arr);
  }

  const baselines = {} as Record<Position, number>;
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as Position[]) {
    const points = (byPos.get(pos) ?? []).sort((a, b) => b - a);
    if (points.length === 0) {
      baselines[pos] = 0;
      continue;
    }
    // Clamp the baseline index into the array; use the last available if the
    // pool is thinner than demand.
    const idx = Math.min(Math.max(demand[pos] - 1, 0), points.length - 1);
    baselines[pos] = points[idx];
  }
  return baselines;
}

/** VBD for a single player against precomputed baselines. */
export function vbdOf(
  player: EffectivePlayer,
  baselines: Record<Position, number>,
): number {
  return player.effProjPoints - baselines[player.position];
}

export type { RosterSlot };
