// ============================================================================
// Generic rankings parser — the heart of the Base Data Swapper.
// ----------------------------------------------------------------------------
// Maps a FantasyPros-style CSV (or any export with the same *columns*, in any
// order) into Player[]. Header names are matched case-insensitively against a
// list of aliases, so future ranking exports drop in without code changes.
//
// The CSV carries no projected points, so we synthesize them from positional
// rank via a per-position decay curve — which is exactly the signal VBD needs.
// ============================================================================

import type { Player, Position } from '../types';

const VALID_POSITIONS = new Set<Position>(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

// Header aliases: first match wins. Add aliases here to support new sources.
const COLUMN_ALIASES = {
  name: ['PLAYER NAME', 'PLAYER', 'NAME'],
  team: ['TEAM', 'TM'],
  pos: ['POS', 'POSITION'],
  rank: ['RK', 'RANK', 'ADP', 'OVERALL', 'ECR'],
  tags: ['TAGS', 'TAG'],
  bye: ['BYE WEEK', 'BYE'],
} as const;

// Projected-points curve per position: points at rank 1 and per-rank decay.
// Illustrative, but shaped to give realistic cross-position VBD baselines.
const PROJ_CURVE: Record<Position, { base: number; step: number }> = {
  QB: { base: 410, step: 3.0 },
  RB: { base: 330, step: 2.2 },
  WR: { base: 325, step: 1.9 },
  TE: { base: 220, step: 2.0 },
  K: { base: 150, step: 1.0 },
  DST: { base: 150, step: 1.2 },
};

function synthProjection(pos: Position, posRank: number): number {
  const { base, step } = PROJ_CURVE[pos];
  return Math.max(40, Math.round(base - step * (posRank - 1)));
}

/** A positive number from column `i`, or undefined when absent/blank/zero. */
function numCol(f: string[], i: number): number | undefined {
  return (i !== -1 && Number(f[i])) || undefined;
}

/** Split one CSV line, honoring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function findColumn(header: string[], aliases: readonly string[]): number {
  for (const alias of aliases) {
    const idx = header.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

export interface ParseOptions {
  /** Player names to tag as Rookie (drives the Age/Upside bot slider). */
  rookieNames?: Set<string>;
  /** Prefix for generated ids; keep unique per source. */
  idPrefix?: string;
}

/** Resolved column indices for the fields we read. -1 means absent. */
interface Columns {
  name: number;
  team: number;
  pos: number;
  rank: number;
  tags: number;
  bye: number;
}

/** An explicit TAGS cell wins; else fall back to rookieNames, default Veteran. */
function resolveTags(f: string[], iTags: number, name: string, opts: ParseOptions): string[] {
  const explicit =
    iTags !== -1 ? (f[iTags] ?? '').split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [];
  if (explicit.length > 0) return explicit;
  return opts.rookieNames?.has(name) ? ['Rookie'] : ['Veteran'];
}

/** Map one CSV row to a Player, or null to skip (blank name / bad position). */
function rowToPlayer(
  f: string[],
  cols: Columns,
  prefix: string,
  r: number,
  posCounters: Map<Position, number>,
  opts: ParseOptions,
): Player | null {
  const name = f[cols.name];
  if (!name) return null;

  const rawPos = (f[cols.pos] ?? '').toUpperCase();
  const position = rawPos.replace(/[0-9]+$/, '') as Position;
  if (!VALID_POSITIONS.has(position)) return null;

  // Positional rank: prefer the number embedded in POS (e.g. "WR12" -> 12),
  // else fall back to a running per-position counter.
  const embedded = parseInt(rawPos.replace(/[^0-9]/g, ''), 10);
  const running = (posCounters.get(position) ?? 0) + 1;
  posCounters.set(position, running);
  const posRank = Number.isFinite(embedded) && embedded > 0 ? embedded : running;

  return {
    id: `${prefix}-${r}`,
    name,
    position,
    team: f[cols.team] || 'FA',
    adp: cols.rank !== -1 && Number(f[cols.rank]) ? Number(f[cols.rank]) : r,
    projPoints: synthProjection(position, posRank),
    bye: numCol(f, cols.bye),
    tags: resolveTags(f, cols.tags, name, opts),
  };
}

/** Parse a rankings CSV string into the engine's Player[] shape. */
export function parseRankingsCsv(raw: string, opts: ParseOptions = {}): Player[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.toUpperCase());
  const cols: Columns = {
    name: findColumn(header, COLUMN_ALIASES.name),
    team: findColumn(header, COLUMN_ALIASES.team),
    pos: findColumn(header, COLUMN_ALIASES.pos),
    rank: findColumn(header, COLUMN_ALIASES.rank),
    tags: findColumn(header, COLUMN_ALIASES.tags),
    bye: findColumn(header, COLUMN_ALIASES.bye),
  };

  if (cols.name === -1 || cols.pos === -1) {
    throw new Error(
      'Rankings CSV needs at least a player-name column and a position column.',
    );
  }

  const prefix = opts.idPrefix ?? 'pl';
  const posCounters = new Map<Position, number>();
  const players: Player[] = [];

  for (let r = 1; r < lines.length; r++) {
    const player = rowToPlayer(splitCsvLine(lines[r]), cols, prefix, r, posCounters, opts);
    if (player) players.push(player);
  }

  return players;
}
