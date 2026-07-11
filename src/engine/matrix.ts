// ============================================================================
// Pick Matrix — the sparse cell map: build, edit, and resolve
// ----------------------------------------------------------------------------
// Turns a SPARSE set of cell overrides + a preset into a concrete, ordered
// list of picks. This one function generalizes Snake, Linear, 3rd-Round
// Reversal (paint round 3 in reverse via cell reassignment), traded picks
// (assignedTeamSlot), keepers (candidate lists), and per-cell timers.
// ============================================================================

import type { KeeperOption, MatrixCell, MatrixPreset, Player, ResolvedPick } from '../types';

export type CellKey = `${number}:${number}`;

export function cellKey(round: number, teamSlot: number): CellKey {
  return `${round}:${teamSlot}`;
}

/** The single keeper locked into a cell/pick THIS run — the lone candidate once
 *  the cell is rolled (or a lone certain keeper shown pre-roll). Undefined while
 *  rival candidates still compete. The candidate list is the one representation;
 *  this derives from it, so no parallel field can drift out of sync. */
export function keptPlayerId(pick: ResolvedPick): string | undefined {
  return pick.kind === 'keeper' ? pick.keeper.playerId : undefined;
}

/** The keeper candidates to preview at a pick — the locked one, the competing set,
 *  or none. The single accessor for a pick's options, so callers read keeper state
 *  through here (or {@link keptPlayerId}) and never destructure the variant. */
export function keeperCandidates(pick: ResolvedPick): KeeperOption[] {
  return pick.kind === 'keeper' ? [pick.keeper] : pick.kind === 'contested' ? pick.candidates : [];
}

/** Read the board ahead for the team on the clock at `cursor`: how many DRAFTABLE
 *  picks it has left, and how many pool players are taken before its next one.
 *  Keeper slots auto-fill from players reserved up front, so they are neither a
 *  real pick nor a pool depletion — they're skipped in both counts. */
export function draftHorizon(order: ResolvedPick[], cursor: number, slot: number): { picksLeft: number; untilNext: number } {
  let picksLeft = 0;
  let untilNext = 0;
  let foundNext = false;
  for (let i = cursor; i < order.length; i++) {
    if (keptPlayerId(order[i])) continue; // keeper slot: no draft, no pool depletion
    if (order[i].owningTeamSlot === slot) {
      picksLeft++;
      if (i > cursor) foundNext = true; // the next slot where this team actually drafts
    } else if (!foundNext) {
      untilNext++;
    }
  }
  return { picksLeft, untilNext };
}

// --- Cell editing: build/mutate the sparse cell map ------------------------
// Kept beside resolution so the whole keeper-cell lifecycle lives in one place;
// callers orchestrate (which slot, which pool) and never hand-edit cells.

/** One keeper edit: make `playerId` a candidate at a cell with probability
 *  `prob` (0-1), or remove that candidate when `prob <= 0`. */
export interface KeeperEdit {
  round: number;
  teamSlot: number;
  playerId: string;
  prob: number;
}

/** Write a cell's keeper candidate list, dropping the whole cell when the list
 *  (and every other override) is empty. */
function setKeepers(cells: Map<CellKey, MatrixCell>, key: CellKey, cell: MatrixCell, keepers: KeeperOption[]) {
  if (keepers.length) {
    cells.set(key, { ...cell, keepers });
  } else {
    const { keepers: _drop, ...rest } = cell;
    if (rest.assignedTeamSlot == null && rest.timerSeconds == null) cells.delete(key);
    else cells.set(key, rest);
  }
}

/** Remove one player from any cell's candidate list, cleaning up an emptied cell. */
function dropCandidate(cells: Map<CellKey, MatrixCell>, playerId: string) {
  for (const [key, cell] of cells) {
    if (cell.keepers?.some((o) => o.playerId === playerId)) {
      setKeepers(cells, key, cell, cell.keepers.filter((o) => o.playerId !== playerId));
    }
  }
}

/** Apply a keeper edit: a player is a candidate in at most one cell, so it is
 *  first removed everywhere, then (unless prob ≤ 0) added to the target cell's
 *  candidate list — joining any others already competing for that pick. */
export function withKeeper(src: Map<CellKey, MatrixCell>, e: KeeperEdit): Map<CellKey, MatrixCell> {
  const cells = new Map(src);
  dropCandidate(cells, e.playerId);
  if (e.prob <= 0) return cells;
  const key = cellKey(e.round, e.teamSlot);
  const existing = cells.get(key) ?? { round: e.round, teamSlot: e.teamSlot };
  const keepers: KeeperOption[] = [...(existing.keepers ?? []), { playerId: e.playerId, prob: Math.min(1, e.prob) }];
  cells.set(key, { ...existing, keepers });
  return cells;
}

/** Upgrade a legacy single-keeper cell (older saves: keeperPlayerId/keeperProb)
 *  to the candidate-list shape, so restored drafts keep their keepers. */
export function migrateCell(c: MatrixCell): MatrixCell {
  const legacy = c as MatrixCell & { keeperPlayerId?: string; keeperProb?: number };
  if (legacy.keeperPlayerId && !c.keepers) {
    const { keeperPlayerId, keeperProb, ...rest } = legacy;
    return { ...rest, keepers: [{ playerId: keeperPlayerId, prob: keeperProb ?? 1 }] };
  }
  return c;
}

/**
 * Re-point keeper candidates to the same-named player in a new pool (separation
 * of concerns: swapping rankings changes players, not your keeper *choices*).
 * Candidates whose player is absent from the new pool are dropped.
 */
export function remapCells(
  cells: Map<CellKey, MatrixCell>,
  oldPlayers: Player[],
  newPlayers: Player[],
): Map<CellKey, MatrixCell> {
  const nameOf = new Map(oldPlayers.map((p) => [p.id, p.name]));
  const newByName = new Map(newPlayers.map((p) => [p.name, p]));
  const out = new Map<CellKey, MatrixCell>();
  for (const [key, cell] of cells) {
    if (!cell.keepers?.length) { out.set(key, cell); continue; }
    const keepers = cell.keepers
      .map((o) => ({ ...o, playerId: newByName.get(nameOf.get(o.playerId) ?? '')?.id }))
      .filter((o): o is KeeperOption => o.playerId != null);
    setKeepers(out, key, cell, keepers);
  }
  return out;
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
      const base = {
        overall, round, teamSlot,
        owningTeamSlot: cell?.assignedTeamSlot ?? teamSlot,
        timerSeconds: cell?.timerSeconds ?? defaultTimerSeconds,
      };
      const keepers = cell?.keepers;
      // The cell's candidate count picks the variant: 0 → open, 1 → locked keeper,
      // 2+ → still contested (a pre-roll preview cell the roll hasn't resolved).
      picks.push(
        !keepers?.length ? { ...base, kind: 'draft' }
          : keepers.length === 1 ? { ...base, kind: 'keeper', keeper: keepers[0] }
            : { ...base, kind: 'contested', candidates: keepers },
      );
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

/** No cap: each keeper cell rolls independently, in insertion order, so a seeded
 *  draft consumes randomness identically to its bot picks. Fixed keepers never
 *  roll (that would consume randomness and shift the seed). */
function rollIndependent(cells: Map<CellKey, MatrixCell>, rng: () => number): Map<CellKey, MatrixCell> {
  const out = new Map(cells);
  for (const [key, cell] of cells)
    if (hasKeeper(cell) && !isFixed(cell)) out.set(key, rollCell(cell, rng));
  return out;
}

/** Capped: the roll is enforced per team (see {@link rollTeam}); `kmax` 0 keeps
 *  nobody. Non-keeper cells pass through unchanged. */
function rollCapped(cells: Map<CellKey, MatrixCell>, rng: () => number, kmax: number): Map<CellKey, MatrixCell> {
  const out = new Map(cells);
  for (const keys of keeperCellsByTeam(cells).values()) {
    const rolled = rollTeam(keys.map((k) => cells.get(k)!), kmax, rng);
    keys.forEach((k, i) => out.set(k, rolled[i]));
  }
  return out;
}

/**
 * Resolve which candidate (if any) each keeper cell keeps THIS run, reducing every
 * cell to its single winner. Pure: no mutation. Dispatches by cap — no cap rolls
 * each cell independently ({@link rollIndependent}), a cap enforces it per team
 * ({@link rollCapped}).
 */
export function rollKeepers(
  cells: Map<CellKey, MatrixCell>,
  rng: () => number,
  keeperCount?: number,
): Map<CellKey, MatrixCell> {
  return keeperCount == null ? rollIndependent(cells, rng) : rollCapped(cells, rng, keeperCount);
}
