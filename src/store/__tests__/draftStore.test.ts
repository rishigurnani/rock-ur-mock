import { describe, it, expect, vi, beforeEach } from 'vitest';
import { snapshot, restoreState, confirmDiscard, assignKeeper, swapSeats, type DraftStore } from '../draftStore';
import { hydratePlayers, listSessions, mergeSessions, type SessionRec, type Snapshot } from '../sessions';
import type { Player } from '../../types';
import { loadDataset } from '../../data/datasets';
import { cellKey, resolvePickOrder, keptPlayerId, remapCells } from '../../engine/matrix';
import { DraftEngine } from '../../engine/draft';
import { DEFAULT_LEAGUE } from '../../data/presets';
import { PRESETS } from '../../engine/bot';
import type { ResolvedPick, Team } from '../../types';

const POOL = loadDataset('fp-2026');
const KEEP_A = 'fp26-1'; // top overall — a bot would grab immediately if not reserved
const KEEP_B = 'fp26-5';

const teams: Team[] = Array.from({ length: 10 }, (_, i) => ({
  id: `t${i + 1}`, slot: i + 1, name: `Bot ${i + 1}`, isBot: true, brain: PRESETS.balanced,
}));

/** Mirrors the attached bug report: two pre-draft keepers on Team 1 (R1 + R3). */
function preDraftWithKeepers(): DraftStore {
  const cells = new Map([
    [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: KEEP_A, prob: 1 }] }],
    [cellKey(3, 1), { round: 3, teamSlot: 1, keepers: [{ playerId: KEEP_B, prob: 1 }] }],
  ]);
  return {
    datasetId: 'fp-2026', players: POOL, config: DEFAULT_LEAGUE, modifiers: [],
    teams, humanSlot: 1, seed: 42, cells, engine: null, started: false, version: 0,
  } as unknown as DraftStore;
}

/** Simulate the full save→download→refresh→upload path via a JSON round-trip. */
const throughFile = (snap: Snapshot): Snapshot => JSON.parse(JSON.stringify(snap));

/** The single resolved/first keeper on a cell. */
const keptId = (cell?: import('../../types').MatrixCell) => cell?.keepers?.[0]?.playerId;

// How PickMatrix decides who occupies a cell (completed pick, else keeper).
const occupantId = (pick: ResolvedPick, completedId?: string) => completedId ?? keptPlayerId(pick);

describe('Session save/restore — keeper persistence (the reported bug)', () => {
  it('keeper cells survive snapshot → JSON file → restore', () => {
    const snap = throughFile(snapshot(preDraftWithKeepers()));
    const patch = restoreState(snap, 1);

    expect(keptId(patch.cells!.get(cellKey(1, 1)))).toBe(KEEP_A);
    expect(keptId(patch.cells!.get(cellKey(3, 1)))).toBe(KEEP_B);
    expect(patch.started).toBe(false);
    expect(patch.engine).toBeNull();
  });

  it('snapshot is self-contained — the whole pool rides along (portable across refresh)', () => {
    const snap = throughFile(snapshot(preDraftWithKeepers()));
    expect(snap.players.length).toBeGreaterThan(400);
    expect(snap.cells).toHaveLength(2);
  });

  it('restored PRE-DRAFT board exposes keeper players at their cells (visible immediately)', () => {
    const patch = restoreState(throughFile(snapshot(preDraftWithKeepers())), 1);
    const order = resolvePickOrder({
      teamCount: 10, roundCount: 15, preset: 'snake', defaultTimerSeconds: 60, cells: patch.cells,
    });
    const r1t1 = order.find((p) => p.round === 1 && p.teamSlot === 1)!;
    const r3t1 = order.find((p) => p.round === 3 && p.teamSlot === 1)!;

    // No completed picks pre-draft, so the occupant is the keeper — this is
    // exactly what was blank on the board before the fix.
    expect(occupantId(r1t1, undefined)).toBe(KEEP_A);
    expect(occupantId(r3t1, undefined)).toBe(KEEP_B);
    expect(POOL.find((p) => p.id === KEEP_A)).toBeTruthy(); // resolvable to a real player
  });

  it('keepers land on the board (once) when the restored draft starts', () => {
    const patch = restoreState(throughFile(snapshot(preDraftWithKeepers())), 1);
    const engine = new DraftEngine({
      players: patch.players!, modifiers: [], teams, config: patch.config!, cells: patch.cells, rng: () => 0.5,
    });
    engine.runToCompletion();

    const at = new Map(engine.completed.map((c) => [`${c.round}:${c.teamSlot}`, c.playerId]));
    expect(at.get('1:1')).toBe(KEEP_A);
    expect(at.get('3:1')).toBe(KEEP_B);

    const ids = engine.completed.map((c) => c.playerId);
    expect(ids.filter((x) => x === KEEP_A)).toHaveLength(1); // reserved, not duplicated
    expect(ids.filter((x) => x === KEEP_B)).toHaveLength(1);
  });

  it('swapping rankings preserves keepers by name (separation of concerns)', () => {
    const p = (id: string, name: string): Player =>
      ({ id, name, position: 'QB', team: 'X', adp: 1, projPoints: 100, tags: [] });
    const oldPool = [p('a1', 'Star QB'), p('a2', 'Traded Away')];
    const newPool = [p('z9', 'Star QB')]; // different ids, "Traded Away" gone
    const cells = new Map([
      [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: 'a1', prob: 1 }] }],
      [cellKey(2, 1), { round: 2, teamSlot: 1, keepers: [{ playerId: 'a2', prob: 1 }] }],
    ]);

    const out = remapCells(cells, oldPool, newPool);
    expect(keptId(out.get(cellKey(1, 1)))).toBe('z9'); // remapped by name
    expect(out.get(cellKey(2, 1))).toBeUndefined(); // player absent → keeper dropped
  });

  it('an in-progress draft round-trips its picks AND its keepers', () => {
    // Spectate draft (no human) partially stepped, then snapshot mid-flight.
    const base = { ...preDraftWithKeepers(), humanSlot: null } as unknown as DraftStore;
    const engine = new DraftEngine({
      players: POOL, modifiers: [], teams, config: DEFAULT_LEAGUE, cells: base.cells, rng: () => 0.5,
    });
    for (let i = 0; i < 25; i++) engine.step();
    const original = engine.completed.map((c) => c.playerId); // includes both keepers

    const live = { ...base, engine, started: true } as unknown as DraftStore;
    const patch = restoreState(throughFile(snapshot(live)), 1);

    expect(patch.started).toBe(true);
    // Restore replays the recorded picks exactly (the prefix), then continues.
    const restored = (patch.engine as DraftEngine).completed.map((c) => c.playerId);
    expect(restored.slice(0, original.length)).toEqual(original);
    // Keeper cells still carry their keepers after restore.
    expect(keptId(patch.cells!.get(cellKey(3, 1)))).toBe(KEEP_B);
  });
});

describe('confirmDiscard — the unsaved-work gate', () => {
  it('proceeds silently when nothing is unsaved (never prompts)', () => {
    const ask = vi.fn(() => true);
    expect(confirmDiscard(false, 'Reset the board', ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks, and honors the answer, when a draft is unsaved', () => {
    expect(confirmDiscard(true, 'Reset the board', () => false)).toBe(false); // user cancels
    expect(confirmDiscard(true, 'Reset the board', () => true)).toBe(true); // user confirms
  });
});

describe('restore backfills byes into older (pre-bye) saves', () => {
  // Simulate a session saved before bye weeks existed: strip byes from the pool.
  const preBye = (): DraftStore => ({
    ...preDraftWithKeepers(),
    players: POOL.map((p) => ({ ...p, bye: undefined })),
  } as DraftStore);

  it('hydratePlayers fills missing byes from the live dataset, keeping overrides', () => {
    const stripped = POOL.map((p) => ({ ...p, bye: undefined, projPoints: 1 })); // 1 = an override
    const hydrated = hydratePlayers(stripped, 'fp-2026');
    expect(hydrated.some((p) => p.bye != null)).toBe(true); // byes restored
    expect(hydrated.every((p) => p.projPoints === 1)).toBe(true); // overrides untouched
  });

  it('falls back to the default pool when the snapshot dataset (uploaded CSV) is gone', () => {
    // The reported case: datasetId "upload-1" no longer registered, but the
    // players share standard names, so byes come from the default pool.
    const stripped = POOL.map((p) => ({ ...p, bye: undefined }));
    expect(hydratePlayers(stripped, 'upload-1').some((p) => p.bye != null)).toBe(true);
  });

  it('leaves a player absent from every pool untouched (no throw)', () => {
    const players = [{ id: 'x', name: 'Nobody At All', position: 'RB', team: 'FA', adp: 1, projPoints: 1, tags: [] } as Player];
    expect(hydratePlayers(players, 'upload-gone')).toEqual(players);
  });

  it('opening a pre-bye snapshot comes back with byes', () => {
    const patch = restoreState(throughFile(snapshot(preBye())), 1);
    expect(patch.players!.some((p) => p.bye != null)).toBe(true);
  });
});

describe('assignKeeper — candidate entry', () => {
  // preDraftWithKeepers gives Team 1 two keepers (KEEP_A @R1, KEEP_B @R3).
  const withCap = (keeperCount: number): DraftStore =>
    ({ ...preDraftWithKeepers(), config: { ...DEFAULT_LEAGUE, keeperCount } } as DraftStore);

  it('lets a team enter MORE keepers than the cap (the cap is enforced at roll time)', () => {
    // Team 1 already holds 2; adding a 3rd with a cap of 2 is still allowed.
    const cells = assignKeeper(withCap(2), { round: 5, teamSlot: 1, playerId: 'fp26-9', prob: 1 }).cells!;
    expect(cells.get(cellKey(5, 1))?.keepers).toEqual([{ playerId: 'fp26-9', prob: 1 }]);
  });

  it('records each candidate with its probability', () => {
    const cells = assignKeeper(withCap(0), { round: 7, teamSlot: 2, playerId: 'fp26-9', prob: 0.6 }).cells!;
    expect(cells.get(cellKey(7, 2))?.keepers).toEqual([{ playerId: 'fp26-9', prob: 0.6 }]);
  });

  it('lets two players compete for the SAME pick (keep A or B), and removes one', () => {
    const s0 = withCap(0);
    const s1 = { ...s0, cells: assignKeeper(s0, { round: 7, teamSlot: 2, playerId: 'A', prob: 0.6 }).cells! } as DraftStore;
    const s2 = { ...s1, cells: assignKeeper(s1, { round: 7, teamSlot: 2, playerId: 'B', prob: 0.4 }).cells! } as DraftStore;
    expect(s2.cells.get(cellKey(7, 2))?.keepers).toEqual([
      { playerId: 'A', prob: 0.6 },
      { playerId: 'B', prob: 0.4 },
    ]);
    // prob 0 removes just that candidate, leaving the other.
    const after = assignKeeper(s2, { round: 7, teamSlot: 2, playerId: 'A', prob: 0 }).cells!;
    expect(after.get(cellKey(7, 2))?.keepers).toEqual([{ playerId: 'B', prob: 0.4 }]);
  });

  it('migrates a legacy single-keeper snapshot (keeperPlayerId) into the candidate list', () => {
    const legacy = { datasetId: 'fp-2026', players: POOL, config: DEFAULT_LEAGUE, modifiers: [], teams,
      humanSlot: 1, seed: 42, started: false, picks: [],
      cells: [{ round: 1, teamSlot: 1, keeperPlayerId: KEEP_A }] } as unknown as Snapshot;
    const patch = restoreState(legacy, 1);
    expect(keptId(patch.cells!.get(cellKey(1, 1)))).toBe(KEEP_A);
  });
});

describe('swapSeats — switching draft positions', () => {
  it('moves a team every slot-indexed thing: keepers, seat, and labels', () => {
    // Team 1 (the human, with both keepers) trades positions with Team 2.
    const p = swapSeats(preDraftWithKeepers(), 1, 2);
    expect(p.humanSlot).toBe(2); // your seat follows you
    expect(keptId(p.cells!.get(cellKey(1, 2)))).toBe(KEEP_A); // keepers land on the new column
    expect(keptId(p.cells!.get(cellKey(3, 2)))).toBe(KEEP_B);
    expect(p.cells!.has(cellKey(1, 1))).toBe(false); // and vacate the old one
    expect(p.teams!.find((t) => t.slot === 2)?.name).toBe('You');
    expect(p.teams!.find((t) => t.slot === 1)?.name).toBe('Bot 1');
    expect(p.teams!.map((t) => t.slot)).toEqual([...Array(10)].map((_, i) => i + 1)); // still 1..10
  });

  it('reassigns traded-pick targets too, and round-trips (a no-op self-swap included)', () => {
    expect(swapSeats(preDraftWithKeepers(), 3, 3)).toEqual({}); // self-swap changes nothing
    const s = { ...preDraftWithKeepers(),
      cells: new Map([[cellKey(2, 5), { round: 2, teamSlot: 5, assignedTeamSlot: 8 }]]) } as DraftStore;
    const once = swapSeats(s, 5, 8);
    expect(once.cells!.get(cellKey(2, 8))?.assignedTeamSlot).toBe(5); // 5↔8 everywhere
    const back = swapSeats({ ...s, ...once } as DraftStore, 5, 8);
    expect(back.cells!.get(cellKey(2, 5))?.assignedTeamSlot).toBe(8); // round-trips to origin
  });
});

describe('backup resilience — merge + corruption fallback', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    } as Storage;
  });
  const rec = (id: string, name = id): SessionRec => ({ id, name, savedAt: 0, status: 'x', snap: {} as Snapshot });

  it('merges by id (incoming wins) and restores the whole log', () => {
    mergeSessions([rec('1', 'A'), rec('2', 'B')]);
    expect(listSessions().map((s) => s.name)).toEqual(['A', 'B']);
    mergeSessions([rec('2', 'B2'), rec('3', 'C')]); // update 2, add 3
    expect(listSessions().map((s) => s.name)).toEqual(['A', 'B2', 'C']);
  });

  it('falls back to the mirror when the primary key is corrupted (no silent wipe)', () => {
    mergeSessions([rec('1', 'A')]); // writes primary + mirror
    store['rockurmock.sessions'] = '{ broken json';
    expect(listSessions().map((s) => s.name)).toEqual(['A']); // recovered from ~bak
  });

  it('respects a legitimately empty log (no zombie drafts)', () => {
    store['rockurmock.sessions'] = '[]';
    expect(listSessions()).toEqual([]);
  });
});
