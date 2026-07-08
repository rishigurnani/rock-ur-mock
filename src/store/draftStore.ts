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
import { CellKey, cellKey, migrateCell, remapCells, withKeeper, type KeeperEdit } from '../engine/matrix';
import { PRESETS } from '../engine/bot';
import {
  DEFAULT_DATASET_ID,
  loadDataset,
  registerUploadedDataset,
} from '../data/datasets';
import { DEFAULT_LEAGUE, makeModifier, MODIFIER_LIBRARY } from '../data/presets';
import { mulberry32 } from '../lib/util';
import { listSessions, writeSessions, mergeSessions, hydratePlayers, SNAPSHOT_SCHEMA, type Snapshot, type SessionRec } from './sessions';

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

/** Swap two draft seats: every slot-indexed piece of setup — team brains, keeper
 *  cells (and any traded-pick target pointing at them) and your own seat — trades
 *  places, so the two managers switch positions in the order. The one primitive
 *  behind move-left, move-right, reverse and shuffle. Pre-draft only. */
export function swapSeats(s: DraftStore, a: number, b: number): Partial<DraftStore> {
  if (a === b) return {};
  const other = (n: number) => (n === a ? b : n === b ? a : n);
  const humanSlot = s.humanSlot == null ? null : other(s.humanSlot);
  const teams = renamedForSeat(
    s.teams.map((t) => ({ ...t, slot: other(t.slot) })).sort((x, y) => x.slot - y.slot),
    humanSlot,
  );
  const cells = new Map<CellKey, MatrixCell>();
  for (const c of s.cells.values()) {
    const teamSlot = other(c.teamSlot);
    const assignedTeamSlot = c.assignedTeamSlot == null ? undefined : other(c.assignedTeamSlot);
    cells.set(cellKey(c.round, teamSlot), { ...c, teamSlot, assignedTeamSlot });
  }
  return { teams, cells, humanSlot };
}

/** Toggle a library modifier on/off by key. */
function toggledModifiers(mods: Modifier[], key: keyof typeof MODIFIER_LIBRARY): Modifier[] {
  const lib = MODIFIER_LIBRARY[key];
  const existing = mods.find((m) => m.matchTag === lib.matchTag && m.action === lib.action);
  return existing ? mods.filter((m) => m !== existing) : [...mods, makeModifier(key)];
}

/** Apply a keeper edit. A team may enter MORE keepers than the league cap
 *  (`keeperCount`): the cap governs how many are actually kept, enforced at roll
 *  time (see rollKeepers), not how many candidates a manager may list. */
export function assignKeeper(s: DraftStore, e: KeeperEdit): Partial<DraftStore> {
  return { cells: withKeeper(s.cells, e) };
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
  // A mid-draft config change edits the live draft, so it becomes unsaved.
  return { config, teams, engine, version: s.version + 1, dirty: s.started || s.dirty };
}

/**
 * The single gate every action that would throw away an unsaved in-progress
 * draft passes through. Returns true to proceed: silent when there's nothing to
 * lose (or outside a browser), otherwise a native confirm. Keeping this here —
 * not in the components — means the whole app gains data-loss protection without
 * a single new dialog, effect, or prop in the UI.
 */
type Confirmer = (message: string) => boolean;
const nativeConfirm: Confirmer = (msg) => (typeof window === 'undefined' ? true : window.confirm(msg));

export function confirmDiscard(dirty: boolean, action: string, ask: Confirmer = nativeConfirm): boolean {
  if (!dirty) return true;
  return ask(`You have an unsaved draft. ${action} anyway?`);
}

/** Human-readable status for a saved session. */
function sessionStatus(s: DraftStore): string {
  const total = s.config.teamCount * s.config.roundCount;
  const done = s.engine?.completed.length ?? 0;
  return !s.started ? 'Setup' : done >= total ? 'Complete' : 'In progress';
}

/**
 * Rebuild the store patch from a snapshot — the single restore path shared by
 * "Open" (a saved session) and "Import" (a dropped JSON file). Keeper cells and
 * the whole pool ride along in the snapshot, so a restored draft is identical
 * to the one that was saved (older snapshots also get missing attributes like
 * bye weeks backfilled). Directly testable: no localStorage.
 */
export function restoreState(snap: Snapshot, version: number): Partial<DraftStore> {
  const cells = new Map<CellKey, MatrixCell>(snap.cells.map((c) => [cellKey(c.round, c.teamSlot), migrateCell(c)]));
  const base = {
    datasetId: snap.datasetId, players: hydratePlayers(snap.players, snap.datasetId), config: snap.config,
    modifiers: snap.modifiers, teams: snap.teams, cells,
    humanSlot: snap.humanSlot, seed: snap.seed,
  };
  return { ...base, engine: snap.started ? buildEngine(base, snap.picks) : null, started: snap.started, version };
}

export function snapshot(s: DraftStore): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
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
  dirty: boolean; // an in-progress draft has unsaved changes (guards data loss)
  activeSessionId: string | null; // the loaded saved session (null = unsaved/new board)

  // setup actions
  setDataset: (id: string) => void;
  uploadDataset: (name: string, csv: string) => void;
  toggleModifier: (key: keyof typeof MODIFIER_LIBRARY) => void;
  setConfig: (patch: Partial<LeagueConfig>) => void;
  setHumanSlot: (slot: number | null) => void;
  swapSlots: (a: number, b: number) => void;
  setBrain: (slot: number, brain: Brain) => void;
  setKeeper: (round: number, teamSlot: number, playerId: string, prob?: number) => void;
  overridePlayer: (playerId: string, patch: Partial<Pick<Player, 'adp' | 'projPoints'>>) => void;

  // sessions (draft log)
  saveSession: (name: string) => void;
  loadSession: (id: string) => void;
  deleteSession: (id: string) => void;
  importSession: (rec: SessionRec) => void;
  importAll: (recs: SessionRec[]) => void;

  // draft lifecycle
  start: () => void;
  reset: () => void;
  step: () => void;
  autoToHuman: () => void;
  makePick: (playerId: string) => void;
}

// --- Imperative actions (engine mutation + session I/O) ---------------------
// Extracted from the store object so the create() body stays a flat list of
// delegations. Each takes zustand's get/set; the discard gate lives inline.
type StoreGet = () => DraftStore;
type StoreSet = (patch: Partial<DraftStore> | ((s: DraftStore) => Partial<DraftStore>)) => void;

function startDraft(set: StoreSet) {
  set((s) => {
    // Fresh seed each run → repeated mocks differ; the stored seed keeps any one
    // draft perfectly reproducible.
    const seed = (Math.random() * 2 ** 32) >>> 0;
    return { seed, engine: buildEngine({ ...s, seed }), started: true, dirty: true, version: s.version + 1 };
  });
}

function persistSession(name: string, get: StoreGet, set: StoreSet) {
  const s = get();
  const id = String(Date.now());
  const list = listSessions().filter((x) => x.name !== name);
  list.push({ id, name, savedAt: Date.now(), status: sessionStatus(s), snap: snapshot(s) });
  writeSessions(list);
  set({ dirty: false, activeSessionId: id, version: s.version + 1 }); // saving clears unsaved changes
}

// Make a saved/imported record the active draft (its cells + pool ride along), and
// mark it as the loaded session so the UI can point at it.
const activate = (rec: SessionRec, set: StoreSet) =>
  set((s) => ({ ...restoreState(rec.snap, s.version + 1), dirty: false, activeSessionId: rec.id }));

function openSession(id: string, get: StoreGet, set: StoreSet) {
  if (!confirmDiscard(get().dirty, 'Open a saved draft')) return;
  const rec = listSessions().find((x) => x.id === id);
  if (rec) activate(rec, set);
}

// Import = add to the log AND make it the active draft (dropping a file is the
// same intent as opening it), so keepers/picks show immediately.
function appendSession(rec: SessionRec, get: StoreGet, set: StoreSet) {
  if (!confirmDiscard(get().dirty, 'Import a draft')) return;
  const saved = { ...rec, id: String(Date.now()) };
  writeSessions([...listSessions(), saved]);
  activate(saved, set);
}

function removeSession(id: string, set: StoreSet) {
  if (typeof window !== 'undefined' && !window.confirm('Delete this saved draft permanently?')) return;
  writeSessions(listSessions().filter((x) => x.id !== id));
  set((s) => ({
    activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    version: s.version + 1,
  }));
}

function resetBoard(get: StoreGet, set: StoreSet) {
  if (!confirmDiscard(get().dirty, 'Reset the board')) return;
  set({ engine: null, started: false, dirty: false, activeSessionId: null, version: get().version + 1 });
}

/** Mutate the live engine via `run`, then flag unsaved changes + re-render. */
function advance(get: StoreGet, set: StoreSet, run: (e: DraftEngine) => void) {
  const { engine } = get();
  if (!engine) return;
  run(engine);
  set({ dirty: true, version: get().version + 1 });
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
  dirty: false,
  activeSessionId: null,

  setDataset: (id) => set((s) => swapDataset(s, id)),

  uploadDataset: (name, csv) => {
    const id = registerUploadedDataset(name, csv);
    set((s) => swapDataset(s, id));
  },

  toggleModifier: (key) => set((s) => ({ modifiers: toggledModifiers(s.modifiers, key) })),

  setConfig: (patch) => set((s) => configPatch(s, patch)),

  setHumanSlot: (slot) => set((s) => ({ humanSlot: slot, teams: renamedForSeat(s.teams, slot) })),

  swapSlots: (a, b) => set((s) => swapSeats(s, a, b)),

  setBrain: (slot, brain) =>
    set((s) => ({ teams: s.teams.map((t) => (t.slot === slot ? { ...t, brain } : t)) })),

  setKeeper: (round, teamSlot, playerId, prob = 1) =>
    set((s) => assignKeeper(s, { round, teamSlot, playerId, prob })),

  overridePlayer: (playerId, patch) =>
    set((s) => ({ players: s.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)) })),

  start: () => startDraft(set),
  saveSession: (name) => persistSession(name, get, set),
  loadSession: (id) => openSession(id, get, set),
  deleteSession: (id) => removeSession(id, set),
  importSession: (rec) => appendSession(rec, get, set),
  importAll: (recs) => { mergeSessions(recs); set((s) => ({ version: s.version + 1 })); },
  reset: () => resetBoard(get, set),
  step: () => advance(get, set, (e) => { if (!e.isComplete) e.step(); }),
  autoToHuman: () => advance(get, set, (e) => e.runToCompletion()),
  // Let bots roll until the human is on the clock again after a manual pick.
  makePick: (playerId) => advance(get, set, (e) => { e.makePick(playerId); e.runToCompletion(); }),
}));

// Warn before a tab close or reload would silently drop an unsaved draft — the
// same discard guard, at the browser's edge. No component owns this concern.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!useDraftStore.getState().dirty) return;
    e.preventDefault();
    e.returnValue = ''; // Chrome/Firefox require a set returnValue to prompt.
  });
}
