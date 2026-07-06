// ============================================================================
// Core domain types — shared by the engine, the stores, and the UI.
// These mirror the PostgreSQL schema but live client-side; the DB is a
// persistence detail, the engine is the source of truth during a live draft.
// ============================================================================

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

/** A slot key used in roster requirements. FLEX accepts RB/WR/TE. */
export type RosterSlot = Position | 'FLEX' | 'BENCH';

export interface Player {
  id: string;
  name: string;
  position: Position;
  team: string;
  /** Consensus average draft position (lower = drafted earlier). */
  adp: number;
  /** Projected fantasy points for the season under baseline scoring. */
  projPoints: number;
  /** Bye week (1-18), when present in the source. Drives bye-stack warnings. */
  bye?: number;
  /** Freeform tags drive the Universal Modifier Engine. e.g. ["Rookie"]. */
  tags: string[];
}

// ---- Universal Modifier Engine --------------------------------------------

export type ModifierAction = 'score_mult' | 'roster_max' | 'adp_boost';

export interface Modifier {
  id: string;
  /** The "If [Tag]" — matches against Player.tags OR Player.position. */
  matchTag: string;
  action: ModifierAction;
  /** score_mult: { factor }, roster_max: { limit }, adp_boost: { pct } */
  params: Record<string, number>;
  priority: number;
  enabled: boolean;
}

// ---- Pick Matrix -----------------------------------------------------------

export type MatrixPreset = 'snake' | 'linear';

/** One keeper candidate competing for a single pick. `prob` (0-1) is the chance
 *  this is the player actually kept; probabilities across a cell's candidates
 *  sum to ≤ 1, the remainder being "nobody kept here". A lone candidate at
 *  prob 1 is an ordinary locked keeper. */
export interface KeeperOption {
  playerId: string;
  prob: number;
}

/** SPARSE override for a single board cell. Absent cell => follows preset. */
export interface MatrixCell {
  round: number;
  teamSlot: number;
  /** Reassign this pick to a different team (traded pick). */
  assignedTeamSlot?: number;
  /** Per-cell timer override, seconds. */
  timerSeconds?: number;
  /** Keeper candidates competing for this pick. The manager keeps at most one;
   *  each mock rolls which (if any) — modeling not knowing what a rival will
   *  keep, or their own "keep A or B with this pick" choice. */
  keepers?: KeeperOption[];
}

// ---- Bots ------------------------------------------------------------------

export interface Brain {
  /** 0 = pure VBD/projection, 100 = pure consensus ADP. */
  adpBias: number;
  /** 0 = deterministic, 100 = wild variance. */
  chaos: number;
  /** 0 = best-player-available, 100 = strictly fill empty starting slots. */
  rosterNeed: number;
  /** 0 = safe veterans, 100 = rookies / upside. */
  ageUpside: number;
}

export interface Team {
  id: string;
  slot: number;
  name: string;
  isBot: boolean;
  brain: Brain;
}

// ---- League configuration --------------------------------------------------

export interface LeagueConfig {
  teamCount: number;
  roundCount: number;
  preset: MatrixPreset;
  /** Starting-lineup requirements. BENCH is capacity beyond starters. */
  rosterSlots: Partial<Record<RosterSlot, number>>;
  /** Max keepers allowed per team (0 / absent = no limit). */
  keeperCount?: number;
}

// ---- Draft runtime ---------------------------------------------------------

/** A fully-resolved pick position after applying the sparse matrix. */
export interface ResolvedPick {
  overall: number;
  round: number;
  /** The board column this pick sits in. */
  teamSlot: number;
  /** Who actually makes the selection (accounts for traded picks). */
  owningTeamSlot: number;
  timerSeconds: number;
  /** The single keeper resolved for this run (set once the cell is rolled, or
   *  when there is exactly one candidate). Absent => an ordinary pick. */
  keeperPlayerId?: string;
  /** Keeper candidates carried through for pre-draft preview / editing. */
  keepers?: KeeperOption[];
}

/** Transparent breakdown behind a single bot valuation (God-Mode tooltip). */
export interface ScoreTrace {
  playerId: string;
  baseValue: number;
  adpBlendLabel: string;
  needMultiplier: number;
  ageMultiplier: number;
  chaosRoll: number;
  finalScore: number;
}

export interface CompletedPick {
  overall: number;
  round: number;
  teamSlot: number;
  playerId: string;
  trace?: ScoreTrace;
}
