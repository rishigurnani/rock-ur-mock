// ============================================================================
// Draft store (Zustand)
// ----------------------------------------------------------------------------
// Holds the setup (config, modifiers, matrix cells, bot brains) and a live
// DraftEngine instance. The engine is imperative/mutable; we bump `version` to
// signal React to re-read snapshots. Setup edits rebuild the engine.
// ============================================================================

import { create } from 'zustand';
import type {
  Brain,
  LeagueConfig,
  MatrixCell,
  Modifier,
  Player,
  Team,
} from '../types';
import { DraftEngine } from '../engine/draft';
import { CellKey, cellKey } from '../engine/matrix';
import { PRESETS } from '../engine/bot';
import {
  DEFAULT_DATASET_ID,
  loadDataset,
  registerUploadedDataset,
} from '../data/datasets';
import { DEFAULT_LEAGUE, makeModifier, MODIFIER_LIBRARY } from '../data/presets';

/** Remove a keeper from a cell; drop the cell entirely if nothing else remains. */
function dropKeeper(cells: Map<CellKey, MatrixCell>, key: CellKey, cell: MatrixCell) {
  const { keeperPlayerId: _drop, ...rest } = cell;
  if (rest.assignedTeamSlot == null && rest.timerSeconds == null) cells.delete(key);
  else cells.set(key, rest);
}

/**
 * Re-point keeper cells to the same-named player in a new pool (separation of
 * concerns: swapping rankings changes players, not your keeper *choices*).
 * Keepers whose player is absent from the new pool are dropped.
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
    if (!cell.keeperPlayerId) { out.set(key, cell); continue; }
    const match = newByName.get(nameOf.get(cell.keeperPlayerId) ?? '');
    if (match) out.set(key, { ...cell, keeperPlayerId: match.id });
    else dropKeeper(out, key, cell);
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultTeams(count: number, humanSlot: number | null): Team[] {
  const presetKeys = Object.keys(PRESETS);
  return Array.from({ length: count }, (_, i) => {
    const slot = i + 1;
    return {
      id: `t${slot}`,
      slot,
      name: slot === humanSlot ? 'You' : `Bot ${slot}`,
      isBot: slot !== humanSlot,
      brain: { ...PRESETS[presetKeys[i % presetKeys.length]] },
    };
  });
}

// --- One primitive to rule them all ----------------------------------------
// Reconstruct an engine from setup state + a list of already-made pick ids.
// Powers BOTH session restore AND every live mid-draft config change: change
// the rounds/roster/teams, replay the picks so far, continue. Keepers (reserved
// out of the pool) can't be forced via makePick, so they fall back to step().
type EngineInput = Pick<DraftStore, 'players' | 'modifiers' | 'teams' | 'config' | 'cells' | 'humanSlot' | 'seed'>;

function buildEngine(s: EngineInput, picks: string[] = []): DraftEngine {
  const engine = new DraftEngine({
    players: s.players, modifiers: s.modifiers, teams: s.teams,
    config: s.config, cells: s.cells, humanSlot: s.humanSlot, rng: mulberry32(s.seed),
  });
  for (const id of picks) {
    try { engine.makePick(id); } catch { engine.step(); }
  }
  engine.runToCompletion();
  return engine;
}

// --- Pure state transitions -------------------------------------------------
// Each setup action delegates to one of these so the store object stays a set
// of one-liners (and no single method accumulates all the branching).

/** Load a pool and rewire keeper cells onto it. Shared by set/upload dataset. */
function swapDataset(s: DraftStore, id: string): Partial<DraftStore> {
  const players = loadDataset(id);
  return { datasetId: id, players, cells: remapCells(s.cells, s.players, players), engine: null, started: false };
}

/** Rename/relabel teams for a new human seat (or spectate). */
function renamedForSeat(teams: Team[], slot: number | null): Team[] {
  return teams.map((t) => ({
    ...t,
    name: t.slot === slot ? 'You' : t.name.startsWith('Bot') || t.name === 'You' ? `Bot ${t.slot}` : t.name,
    isBot: t.slot !== slot,
  }));
}

/** Toggle a library modifier on/off by key. */
function toggledModifiers(mods: Modifier[], key: keyof typeof MODIFIER_LIBRARY): Modifier[] {
  const lib = MODIFIER_LIBRARY[key];
  const existing = mods.find((m) => m.matchTag === lib.matchTag && m.action === lib.action);
  return existing ? mods.filter((m) => m !== existing) : [...mods, makeModifier(key)];
}

/** Set (or clear, when playerId is null) the keeper for one board cell. */
function withKeeper(src: Map<CellKey, MatrixCell>, round: number, teamSlot: number, playerId: string | null): Map<CellKey, MatrixCell> {
  const cells = new Map(src);
  const key = cellKey(round, teamSlot);
  // A player can only be kept in one cell — clear any prior assignment.
  if (playerId) for (const [k, c] of cells) if (c.keeperPlayerId === playerId) dropKeeper(cells, k, c);
  const existing = cells.get(key) ?? { round, teamSlot };
  if (playerId) cells.set(key, { ...existing, keeperPlayerId: playerId });
  else dropKeeper(cells, key, existing);
  return cells;
}

/** Apply a config patch, rebuilding+replaying a live draft around it. */
function configPatch(s: DraftStore, patch: Partial<LeagueConfig>): Partial<DraftStore> {
  const config = { ...s.config, ...patch };
  const teams =
    patch.teamCount && patch.teamCount !== s.config.teamCount
      ? defaultTeams(patch.teamCount, s.humanSlot)
      : s.teams;
  const engine = s.started && s.engine
    ? buildEngine({ ...s, config, teams }, s.engine.completed.map((c) => c.playerId))
    : s.engine;
  return { config, teams, engine, version: s.version + 1 };
}

/** Human-readable status for a saved session. */
function sessionStatus(s: DraftStore): string {
  const total = s.config.teamCount * s.config.roundCount;
  const done = s.engine?.completed.length ?? 0;
  return !s.started ? 'Setup' : done >= total ? 'Complete' : 'In progress';
}

// --- Sessions: the draft log, persisted to localStorage --------------------
// Snapshots are SELF-CONTAINED: the whole pool is stored inline, so uploaded
// CSVs, per-player overrides and injury what-ifs all persist, and a session is
// portable (export/import) independent of the dataset registry.
interface Snapshot extends Pick<DraftStore, 'datasetId' | 'players' | 'config' | 'modifiers' | 'teams' | 'humanSlot' | 'seed' | 'started'> {
  cells: MatrixCell[];
  picks: string[];
}
export interface SessionRec { id: string; name: string; savedAt: number; status: string; snap: Snapshot; }
export type { Snapshot };

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
export function listSessions(): SessionRec[] {
  try { return JSON.parse(localStorage.getItem(SKEY) || '[]'); } catch { return []; }
}
const writeSessions = (l: SessionRec[]) => localStorage.setItem(SKEY, JSON.stringify(l));

/**
 * Rebuild the store patch from a snapshot — the single restore path shared by
 * "Open" (a saved session) and "Import" (a dropped JSON file). Keeper cells and
 * the whole pool ride along in the snapshot, so a restored draft is identical
 * to the one that was saved. Pure: no localStorage, so it is directly testable.
 */
export function restoreState(snap: Snapshot, version: number): Partial<DraftStore> {
  const cells = new Map<CellKey, MatrixCell>(snap.cells.map((c) => [cellKey(c.round, c.teamSlot), c]));
  const base = {
    datasetId: snap.datasetId, players: snap.players, config: snap.config,
    modifiers: snap.modifiers, teams: snap.teams, cells,
    humanSlot: snap.humanSlot, seed: snap.seed,
  };
  return { ...base, engine: snap.started ? buildEngine(base, snap.picks) : null, started: snap.started, version };
}

export function snapshot(s: DraftStore): Snapshot {
  return {
    datasetId: s.datasetId, players: s.players, config: s.config, modifiers: s.modifiers,
    teams: s.teams, humanSlot: s.humanSlot, seed: s.seed, started: s.started,
    cells: [...s.cells.values()],
    picks: s.engine ? s.engine.completed.map((c) => c.playerId) : [],
  };
}

export interface DraftStore {
  datasetId: string;
  players: Player[];
  config: LeagueConfig;
  modifiers: Modifier[];
  cells: Map<CellKey, MatrixCell>;
  teams: Team[];
  humanSlot: number | null;
  seed: number;

  engine: DraftEngine | null;
  started: boolean;
  version: number; // bump to force re-render after imperative engine mutation

  // setup actions
  setDataset: (id: string) => void;
  uploadDataset: (name: string, csv: string) => void;
  toggleModifier: (key: keyof typeof MODIFIER_LIBRARY) => void;
  setConfig: (patch: Partial<LeagueConfig>) => void;
  setHumanSlot: (slot: number | null) => void;
  setBrain: (slot: number, brain: Brain) => void;
  setKeeper: (round: number, teamSlot: number, playerId: string | null) => void;
  overridePlayer: (playerId: string, patch: Partial<Pick<Player, 'adp' | 'projPoints'>>) => void;

  // sessions (draft log)
  saveSession: (name: string) => void;
  loadSession: (id: string) => void;
  deleteSession: (id: string) => void;
  importSession: (rec: SessionRec) => void;

  // draft lifecycle
  start: () => void;
  reset: () => void;
  step: () => void;
  autoToHuman: () => void;
  makePick: (playerId: string) => void;
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  datasetId: DEFAULT_DATASET_ID,
  players: loadDataset(DEFAULT_DATASET_ID),
  config: DEFAULT_LEAGUE,
  modifiers: [],
  cells: new Map(),
  teams: defaultTeams(DEFAULT_LEAGUE.teamCount, 1),
  humanSlot: 1,
  seed: 42,

  engine: null,
  started: false,
  version: 0,

  setDataset: (id) => set((s) => swapDataset(s, id)),

  uploadDataset: (name, csv) => {
    const id = registerUploadedDataset(name, csv);
    set((s) => swapDataset(s, id));
  },

  toggleModifier: (key) => set((s) => ({ modifiers: toggledModifiers(s.modifiers, key) })),

  setConfig: (patch) => set((s) => configPatch(s, patch)),

  setHumanSlot: (slot) => set((s) => ({ humanSlot: slot, teams: renamedForSeat(s.teams, slot) })),

  setBrain: (slot, brain) =>
    set((s) => ({ teams: s.teams.map((t) => (t.slot === slot ? { ...t, brain } : t)) })),

  setKeeper: (round, teamSlot, playerId) =>
    set((s) => ({ cells: withKeeper(s.cells, round, teamSlot, playerId) })),

  overridePlayer: (playerId, patch) =>
    set((s) => ({ players: s.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)) })),

  start: () =>
    set((s) => {
      // Fresh seed each run → repeated mocks actually differ. The seed is stored
      // (and snapshotted), so any single draft stays perfectly reproducible.
      const seed = (Math.random() * 2 ** 32) >>> 0;
      return { seed, engine: buildEngine({ ...s, seed }), started: true, version: s.version + 1 };
    }),

  saveSession: (name) =>
    set((s) => {
      const list = listSessions().filter((x) => x.name !== name);
      list.push({ id: String(Date.now()), name, savedAt: Date.now(), status: sessionStatus(s), snap: snapshot(s) });
      writeSessions(list);
      return { version: s.version + 1 };
    }),

  loadSession: (id) =>
    set((s) => {
      const rec = listSessions().find((x) => x.id === id);
      return rec ? restoreState(rec.snap, s.version + 1) : {};
    }),

  deleteSession: (id) =>
    set((s) => {
      writeSessions(listSessions().filter((x) => x.id !== id));
      return { version: s.version + 1 };
    }),

  // Import = add to the log AND make it the active draft (dropping a file is
  // the same intent as opening it), so keepers/picks show immediately.
  importSession: (rec) =>
    set((s) => {
      writeSessions([...listSessions(), { ...rec, id: String(Date.now()) }]);
      return restoreState(rec.snap, s.version + 1);
    }),

  reset: () => set({ engine: null, started: false, version: get().version + 1 }),

  step: () => {
    const { engine } = get();
    if (!engine || engine.isComplete) return;
    engine.step();
    set({ version: get().version + 1 });
  },

  autoToHuman: () => {
    const { engine } = get();
    if (!engine) return;
    engine.runToCompletion();
    set({ version: get().version + 1 });
  },

  makePick: (playerId) => {
    const { engine } = get();
    if (!engine) return;
    engine.makePick(playerId);
    engine.runToCompletion(); // let bots roll until the human is on the clock again
    set({ version: get().version + 1 });
  },
}));
