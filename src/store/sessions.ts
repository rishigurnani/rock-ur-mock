// ============================================================================
// Session persistence — the ONE owner of the saved-draft FORMAT and its store:
// the Snapshot shape (+ schema version), the mirrored localStorage log, and the
// name-matched backfill. `DraftStore` is type-only here, so no runtime cycle.
// ============================================================================

import type { DraftStore } from './draftStore';
import type { MatrixCell, Player } from '../types';
import { DEFAULT_DATASET_ID, loadDataset } from '../data/datasets';
import { orderFromCells } from '../engine/matrix';

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
  loves?: string[]; // player ids the manager hearted (absent in legacy saves)
}
export interface SessionRec { id: string; name: string; savedAt: number; status: string; snap: Snapshot; }

/** Lowercase search blob for a saved draft — name, status, seat, pool, size, and the players on YOUR team (the Drafts search corpus). */
export function sessionSearchText(rec: SessionRec): string {
  const s = rec.snap;
  const byId = new Map(s.players.map((p) => [p.id, p]));
  const mine = orderFromCells(s.config, s.cells).map((o, i) => (o.owningTeamSlot === s.humanSlot ? byId.get(s.picks[i])?.name : ''));
  return [rec.name, rec.status, `slot ${s.humanSlot}`, s.datasetId, `${s.config.teamCount} team`, `${s.config.roundCount} round`, ...mine].join(' ').toLowerCase();
}

const SKEY = 'rockurmock.sessions';
// One-time migration: carry saved drafts over from the old "sleeperg" key so
// nothing is lost on the rename. Returns whether the key was reconciled; a throw
// means storage is blocked (private mode / disabled) — a safe skip, not a crash.
function migrateLegacyKey(): boolean {
  try {
    const legacy = localStorage.getItem('sleeperg.sessions');
    if (legacy && !localStorage.getItem(SKEY)) localStorage.setItem(SKEY, legacy);
    if (legacy) localStorage.removeItem('sleeperg.sessions');
    return true;
  } catch {
    return false; // storage unavailable — nothing migrated, app runs on the primary key
  }
}
// Guarded for non-browser (test) environments.
if (typeof localStorage !== 'undefined') migrateLegacyKey();
// A deployed origin's localStorage is "best-effort": the browser may evict it
// between visits under storage pressure (localhost is exempt, which is why saves
// survive in dev but vanish on the live site). Ask to mark it persistent so saved
// drafts aren't reclaimed. Fire-and-forget; unsupported browsers just skip it.
if (typeof navigator !== 'undefined') void navigator.storage?.persist?.();
// Every write is mirrored to a shadow key; a read falls back to it when the primary
// is unparseable (corruption) OR missing (a lost/evicted key), never when it's a
// legit empty list '[]' — so losing one key can't silently wipe the log while the
// mirror survives. (A full site-data clear takes both; Backup-all is the durable copy.)
const BAK = SKEY + '~bak';

// --- Pool dedup (storage format v2) -----------------------------------------
// Each draft embedded the full ~539-player pool; across many saves that's ~90%
// duplicated bytes and it blew the browser's localStorage quota. Instead we keep a
// few BASE pools once and store each draft's DIFF against the closest >60%-similar
// base (else it becomes a new base). Transparent: listSessions rehydrates the full
// snapshot, so export files and every caller still see the portable, self-contained shape.
type Diff = { base: number; changed: Player[]; removed: string[] };
type Packed = Omit<SessionRec, 'snap'> & { snap: Omit<Snapshot, 'players'> & { pool: Diff } };
interface StoredLog { v: 2; bases: Player[][]; recs: Packed[] }

/** Fraction of `pool` byte-identical (same id AND content) to base `b`. */
function similarity(pool: Player[], b: Player[]): number {
  const json = new Map(b.map((p) => [p.id, JSON.stringify(p)]));
  return pool.length ? pool.filter((p) => json.get(p.id) === JSON.stringify(p)).length / pool.length : 1;
}
/** Diff `pool` against the closest >60%-similar base, else register it as a new base. */
function diffPool(pool: Player[], bases: Player[][]): Diff {
  let base = -1, best = 0.6;
  bases.forEach((b, i) => { const s = similarity(pool, b); if (s > best) { best = s; base = i; } });
  if (base < 0) base = bases.push(pool) - 1;
  const json = new Map(bases[base].map((p) => [p.id, JSON.stringify(p)]));
  const have = new Set(pool.map((p) => p.id));
  return { base, changed: pool.filter((p) => json.get(p.id) !== JSON.stringify(p)), removed: bases[base].filter((p) => !have.has(p.id)).map((p) => p.id) };
}
function packLog(l: SessionRec[]): StoredLog {
  const bases: Player[][] = [];
  return { v: 2, bases, recs: l.map(({ snap: { players, ...snap }, ...r }) => ({ ...r, snap: { ...snap, pool: diffPool(players ?? [], bases) } })) };
}
function unpackLog(s: StoredLog): SessionRec[] {
  return s.recs.map(({ snap: { pool, ...snap }, ...r }) => {
    const removed = new Set(pool.removed), byId = new Map<string, Player>();
    for (const p of s.bases[pool.base]) if (!removed.has(p.id)) byId.set(p.id, p);
    for (const p of pool.changed) byId.set(p.id, p);
    return { ...r, snap: { ...snap, players: [...byId.values()] } };
  });
}
/** Decode a stored blob: a legacy full array, or the v2 deduped log (null = corrupt). */
function decode(raw: string): SessionRec[] | null {
  try { const d = JSON.parse(raw); return Array.isArray(d) ? d : d?.v === 2 ? unpackLog(d) : null; } catch { return null; }
}

/** Read one stored log; null when the key is MISSING (lost/evicted) or corrupt so the
 *  caller tries the mirror, [] only for a stored (legit) empty list. */
function readLog(key: string): SessionRec[] | null {
  const raw = localStorage.getItem(key);
  return raw == null ? null : decode(raw);
}
export function listSessions(): SessionRec[] {
  return readLog(SKEY) ?? readLog(BAK) ?? [];
}
export const writeSessions = (l: SessionRec[]) => {
  const json = JSON.stringify(packLog(l));
  try { localStorage.setItem(SKEY, json); localStorage.setItem(BAK, json); }
  catch (e) {
    // Don't fail silently — and by rethrowing, don't let the caller mark it "saved".
    if (typeof alert === 'function') alert('Storage is full — use "Backup all" to export your drafts, then delete old ones to free space.');
    throw e;
  }
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
