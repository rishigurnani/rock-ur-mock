// ============================================================================
// Cross-mock analytics — ONE pass over the selected drafts yields every view:
// your starting-lineup outcome distribution, seat counts, and the player market
// (where each drafted player goes, and your exposure). Keepers are reserved
// (never on the board), so they are excluded from the market. Merged by player
// NAME so drafts run on different ranking pools still align.
// ============================================================================

import type { MatrixCell, Player, ResolvedPick } from '../types';
import type { Snapshot } from '../store/sessions';
import { cellKey, resolvePickOrder, keeperCandidates, CellKey } from './matrix';
import { optimizeLineup } from './roster';

/** Exactly the slice of a saved Snapshot the stats read, plus its name. Derived
 *  from Snapshot (type-only import) so it can't drift as the save format evolves;
 *  no runtime dependency on the store. */
export type MockInput = Pick<Snapshot, 'players' | 'picks' | 'humanSlot' | 'config' | 'cells'> & { name: string };

export interface PlayerStat {
  player: Player;
  avgPick: number;
  kept: number; // drafts in which the player was a keeper (any team)
  yours: number; // drafts in which the player was DRAFTED onto YOUR roster
}

export interface MockReport {
  drafts: number;
  players: PlayerStat[];
  starterMean: number;
  starterStd: number;
  starterFloor: number; // p10
  starterMedian: number;
  starterCeiling: number; // p90
  bestDraft: string;
  worstDraft: string;
  /** How often you held each draft slot, most-frequent first. */
  yourSlots: { slot: number; count: number }[];
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a: number[], m = mean(a)) => Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
const pctl = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

type Agg = { player: Player; picks: number[]; yours: number; kept: number };

/** IDs taken at a keeper cell this mock — reserved, never on the board, so kept
 *  off the market: a pick is a keeper when its player is one of the cell's candidates. */
function keptIds(order: ResolvedPick[], picks: string[]): Set<string> {
  const kept = new Set<string>();
  order.forEach((o, i) => { if (keeperCandidates(o).some((k) => k.playerId === picks[i])) kept.add(picks[i]); });
  return kept;
}

/** Fold one mock into the running player aggregate + slot counts; returns this
 *  mock's starting-lineup points for the outcome distribution. */
function accumulate(m: MockInput, agg: Map<string, Agg>, slotCount: Map<number, number>): number {
  if (m.humanSlot != null) slotCount.set(m.humanSlot, (slotCount.get(m.humanSlot) ?? 0) + 1);
  const byId = new Map(m.players.map((p) => [p.id, p]));
  const order = resolvePickOrder({
    teamCount: m.config.teamCount, roundCount: m.config.roundCount, preset: m.config.preset,
    defaultTimerSeconds: 0,
    cells: new Map<CellKey, MatrixCell>(m.cells.map((c) => [cellKey(c.round, c.teamSlot), c])),
  });
  const kept = keptIds(order, m.picks);
  const mine: Player[] = [];
  m.picks.forEach((id, i) => {
    const yours = m.humanSlot != null && order[i]?.owningTeamSlot === m.humanSlot;
    const p = byId.get(id);
    if (yours && p) mine.push(p); // your roster includes your keepers
    if (!p) return;
    const e = agg.get(p.name) ?? { player: p, picks: [], yours: 0, kept: 0 };
    if (kept.has(id)) e.kept += 1; // keepers count, but stay off the board math
    else { e.picks.push(i + 1); if (yours) e.yours += 1; }
    agg.set(p.name, e);
  });
  return optimizeLineup(mine, m.config.rosterSlots).startingPoints;
}

export function mockStats(mocks: MockInput[]): MockReport {
  const agg = new Map<string, Agg>();
  const slotCount = new Map<number, number>();
  const starterPts = mocks.map((m) => accumulate(m, agg, slotCount));

  const players = [...agg.values()]
    .filter((e) => e.picks.length) // drafted at least once; pure keepers stay off the market
    .map(({ player, picks, yours, kept }) => ({ player, yours, kept, avgPick: mean(picks) }))
    .sort((a, b) => b.yours - a.yours || a.avgPick - b.avgPick);

  const sorted = [...starterPts].sort((a, b) => a - b);
  const best = starterPts.indexOf(Math.max(...starterPts));
  const worst = starterPts.indexOf(Math.min(...starterPts));
  return {
    drafts: mocks.length, players,
    starterMean: mean(starterPts), starterStd: std(starterPts),
    starterFloor: pctl(sorted, 0.1), starterMedian: pctl(sorted, 0.5), starterCeiling: pctl(sorted, 0.9),
    bestDraft: mocks[best]?.name ?? '', worstDraft: mocks[worst]?.name ?? '',
    yourSlots: [...slotCount.entries()].map(([slot, count]) => ({ slot, count })).sort((a, b) => b.count - a.count),
  };
}
