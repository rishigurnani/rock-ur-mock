// ============================================================================
// Session persistence — the ONE owner of the saved-draft FORMAT and its store:
// the Snapshot shape (+ schema version), the mirrored localStorage log, and the
// name-matched backfill. `DraftStore` is type-only here, so no runtime cycle.
// ============================================================================

import type { DraftStore } from './draftStore';
import type { MatrixCell, Player } from '../types';
import { DEFAULT_DATASET_ID, loadDataset } from '../data/datasets';

/** Bump on any breaking change to the Snapshot shape. Stamped into every save so
 *  older backup files on disk can be migrated explicitly instead of breaking. */
export const SNAPSHOT_SCHEMA = 1;

// Snapshots are SELF-CONTAINED: the whole pool is stored inline, so uploaded
// CSVs, per-player overrides and injury what-ifs all persist, and a session is
// portable (export/import) independent of the dataset registry.
export interface Snapshot extends Pick<DraftStore, 'datasetId' | 'players' | 'config' | 'modifiers' | 'teams' | 'humanSlot' | 'seed' | 'started'> {
  schema?: number; // format version; absent = a pre-versioning (legacy) save
  cells: MatrixCell[];
  picks: string[];
}
export interface SessionRec { id: string; name: string; savedAt: number; status: string; snap: Snapshot; }

const SKEY = 'rockurmock.sessions';
// One-time migration: carry saved drafts over from the old "sleeperg" key so
// nothing is lost on the rename. Guarded for non-browser (test) environments.
if (typeof localStorage !== 'undefined') {
  try {
    const legacy = localStorage.getItem('sleeperg.sessions');
    if (legacy && !localStorage.getItem(SKEY)) localStorage.setItem(SKEY, legacy);
    if (legacy) localStorage.removeItem('sleeperg.sessions');
  } catch { /* ignore */ }
}
// Every write is mirrored to a shadow key; a read falls back to it ONLY when the
// primary is unparseable (corruption), never when it's a legit empty list — so a
// single corrupted key can't silently wipe the log. (A full site-data clear takes
// both; the Backup-all file is the real durable copy.)
const BAK = SKEY + '~bak';
/** Parse one stored log; null on a corrupt (unparseable) value, [] on a missing key. */
function readLog(key: string): SessionRec[] | null {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch { return null; }
}
export function listSessions(): SessionRec[] {
  return readLog(SKEY) ?? readLog(BAK) ?? [];
}
export const writeSessions = (l: SessionRec[]) => {
  const json = JSON.stringify(l);
  localStorage.setItem(SKEY, json);
  localStorage.setItem(BAK, json);
};

/** Merge imported records into the log (incoming wins by id) — the Restore path. */
export function mergeSessions(recs: SessionRec[]): number {
  const byId = new Map(listSessions().map((s) => [s.id, s]));
  for (const r of recs) if (r?.id && r?.snap) byId.set(r.id, r);
  writeSessions([...byId.values()]);
  return byId.size;
}

/** The snapshot's own dataset, or the default pool when it's gone — an uploaded
 *  CSV lives only in memory and vanishes on reload, so `upload-*` ids won't
 *  resolve, but its players share the standard names we can still source from. */
function poolFor(datasetId: string): Player[] {
  try { return loadDataset(datasetId); } catch { return loadDataset(DEFAULT_DATASET_ID); }
}

/**
 * Backfill player attributes a snapshot predates (e.g. bye weeks, added after
 * some drafts were saved), matched by name. Only fills gaps — never clobbers a
 * saved value or a per-player override.
 */
export function hydratePlayers(players: Player[], datasetId: string): Player[] {
  const byeByName = new Map(poolFor(datasetId).map((p) => [p.name, p.bye]));
  return players.map((p) =>
    p.bye == null && byeByName.get(p.name) != null ? { ...p, bye: byeByName.get(p.name) } : p,
  );
}
