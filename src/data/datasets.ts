// ============================================================================
// Dataset registry — the "Base Data Swapper" dropdown, as data.
// ----------------------------------------------------------------------------
// One list of named sources. Each yields Player[] on demand (memoized). To add
// a new ranking in the future: drop a CSV in src/data/ and add ONE line here.
// Runtime CSV uploads register through registerUploadedDataset().
// ============================================================================

import type { Player } from '../types';
import { parseRankingsCsv } from './parseRankings';
import { DATASET_2026 } from './dataset2026';
import fantasyProsRaw from './FantasyPros_2026_Draft_ALL_Rankings.csv?raw';

export interface DatasetSource {
  id: string;
  name: string;
  /** Lazily produce the player pool. Kept sync; CSVs import as ?raw strings. */
  load: () => Player[];
}

// --- Built-in sources -------------------------------------------------------
const BUILTIN: DatasetSource[] = [
  {
    id: 'fp-2026',
    name: 'FantasyPros 2026 — All (539)',
    load: () => parseRankingsCsv(fantasyProsRaw, { idPrefix: 'fp26' }),
  },
  {
    id: 'curated-2026',
    name: 'Curated 2026 (hand-tuned)',
    load: () => DATASET_2026,
  },
];

// Uploaded-at-runtime sources live alongside the built-ins.
const uploaded: DatasetSource[] = [];

export const DEFAULT_DATASET_ID = 'fp-2026';

export function listDatasets(): DatasetSource[] {
  return [...BUILTIN, ...uploaded];
}

const cache = new Map<string, Player[]>();

/** Load (and memoize) a dataset's players by id. */
export function loadDataset(id: string): Player[] {
  const cached = cache.get(id);
  if (cached) return cached;
  const source = listDatasets().find((d) => d.id === id);
  if (!source) throw new Error(`Unknown dataset: ${id}`);
  const players = source.load();
  cache.set(id, players);
  return players;
}

/** Register a user-uploaded CSV as a new selectable dataset. Returns its id. */
export function registerUploadedDataset(name: string, csv: string): string {
  const id = `upload-${uploaded.length + 1}`;
  const players = parseRankingsCsv(csv, { idPrefix: id });
  uploaded.push({ id, name, load: () => players });
  cache.set(id, players);
  return id;
}
