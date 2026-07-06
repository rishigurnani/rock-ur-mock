// ============================================================================
// Pick Matrix resolver
// ----------------------------------------------------------------------------
// Turns a SPARSE set of cell overrides + a preset into a concrete, ordered
// list of picks. This one function generalizes Snake, Linear, 3rd-Round
// Reversal (paint round 3 in reverse via cell reassignment), traded picks
// (assignedTeamSlot), keepers (candidate lists), and per-cell timers.
// ============================================================================

import type { KeeperOption, MatrixCell, MatrixPreset, ResolvedPick } from '../types';

export type CellKey = `${number}:${number}`;

export function cellKey(round: number, teamSlot: number): CellKey {
  return `${round}:${teamSlot}`;
}

/** The single keeper locked into a cell/pick THIS run — the lone candidate once
 *  the cell is rolled (or a lone certain keeper shown pre-roll). Undefined while
 *  rival candidates still compete. The candidate list is the one representation;
 *  this derives from it, so no parallel field can drift out of sync. */
export function keptPlayerId(source: { keepers?: KeeperOption[] }): string | undefined {
  return source.keepers?.length === 1 ? source.keepers[0].playerId : undefined;
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
        // The candidate list is the single source of truth; the lone resolved
        // keeper is derived on demand via keptPlayerId(pick).
        keepers: cell?.keepers,
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

const hasKeeper = (cell: MatrixCell) => (cell.keepers?.length ?? 0) > 0;
/** A lone certain candidate (prob ≥ 1) is an ordinary locked keeper; it never
 *  rolls, so seeded drafts with only fixed keepers stay reproducible. */
const isFixed = (cell: MatrixCell) => cell.keepers?.length === 1 && cell.keepers[0].prob >= 1;
const stripKeepers = ({ keepers: _drop, ...rest }: MatrixCell): MatrixCell => rest;
const countKept = (cells: MatrixCell[]) => cells.reduce((n, c) => n + (hasKeeper(c) ? 1 : 0), 0);

/** Reduce one cell to its single rolled winner (or nobody kept). */
function rollCell(cell: MatrixCell, rng: () => number): MatrixCell {
  const winner = pickWinner(cell.keepers!, rng());
  const rest = stripKeepers(cell);
  return winner ? { ...rest, keepers: [winner] } : rest;
}

/** Scale a team's candidate probabilities so the expected number kept lands in
 *  [kmax/2, kmax]: a too-timid board is lifted, a too-greedy one trimmed. */
function normalizeTeam(cells: MatrixCell[], kmax: number): MatrixCell[] {
  const sum = cells.reduce((s, c) => s + c.keepers!.reduce((a, o) => a + o.prob, 0), 0);
  const f = sum <= 0 ? 1 : sum < kmax / 2 ? kmax / 2 / sum : sum > kmax ? kmax / sum : 1;
  return f === 1
    ? cells
    : cells.map((c) => ({ ...c, keepers: c.keepers!.map((o) => ({ ...o, prob: Math.min(1, o.prob * f) })) }));
}

/** Bound the rejection sampler — a safety valve; in practice a valid roll is
 *  found in a handful of tries once the board is normalized. */
const MAX_KEEPER_ROLLS = 1000;

/** Roll one team's keeper cells under a hard cap of `kmax` kept. When the board
 *  offers at least `kmax` keepers, exactly `kmax` are kept: normalize, then
 *  rejection-sample rolls until the count lands on the cap. Too few candidates
 *  (or kmax 0) skip the cap and roll as-is. */
function rollTeam(cells: MatrixCell[], kmax: number, rng: () => number): MatrixCell[] {
  if (kmax <= 0) return cells.map(stripKeepers); // exactly zero kept
  if (cells.length < kmax) return cells.map((c) => rollCell(c, rng)); // can't reach the cap
  const norm = normalizeTeam(cells, kmax);
  let rolled = norm.map((c) => rollCell(c, rng));
  for (let i = 0; i < MAX_KEEPER_ROLLS && countKept(rolled) !== kmax; i++) {
    rolled = norm.map((c) => rollCell(c, rng));
  }
  return rolled;
}

/** Group keeper-bearing cell keys by owning team, preserving insertion order. */
function keeperCellsByTeam(cells: Map<CellKey, MatrixCell>): Map<number, CellKey[]> {
  const byTeam = new Map<number, CellKey[]>();
  for (const [key, cell] of cells) {
    if (hasKeeper(cell)) byTeam.set(cell.teamSlot, [...(byTeam.get(cell.teamSlot) ?? []), key]);
  }
  return byTeam;
}

/**
 * Resolve which candidate (if any) each keeper cell keeps THIS run, reducing every
 * cell to its single winner. Pure: no mutation.
 *
 * With no cap (`keeperCount` absent) each cell rolls independently, in insertion
 * order (so a seeded draft consumes randomness identically to its bot picks). With
 * a cap the roll is enforced per team (see {@link rollTeam}); `keeperCount` 0 keeps
 * nobody. Non-keeper cells always pass through unchanged.
 */
export function rollKeepers(
  cells: Map<CellKey, MatrixCell>,
  rng: () => number,
  keeperCount?: number,
): Map<CellKey, MatrixCell> {
  const out = new Map(cells);
  if (keeperCount == null) {
    for (const [key, cell] of cells)
      if (hasKeeper(cell) && !isFixed(cell)) out.set(key, rollCell(cell, rng));
    return out;
  }
  for (const keys of keeperCellsByTeam(cells).values()) {
    const rolled = rollTeam(keys.map((k) => cells.get(k)!), keeperCount, rng);
    keys.forEach((k, i) => out.set(k, rolled[i]));
  }
  return out;
}
