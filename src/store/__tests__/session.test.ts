import { describe, it, expect } from 'vitest';
import { snapshot, restoreState, remapCells, type Snapshot, type DraftStore } from '../draftStore';
import type { Player } from '../../types';
import { loadDataset } from '../../data/datasets';
import { cellKey, resolvePickOrder } from '../../engine/matrix';
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
    [cellKey(1, 1), { round: 1, teamSlot: 1, keeperPlayerId: KEEP_A }],
    [cellKey(3, 1), { round: 3, teamSlot: 1, keeperPlayerId: KEEP_B }],
  ]);
  return {
    datasetId: 'fp-2026', players: POOL, config: DEFAULT_LEAGUE, modifiers: [],
    teams, humanSlot: 1, seed: 42, cells, engine: null, started: false, version: 0,
  } as unknown as DraftStore;
}

/** Simulate the full save→download→refresh→upload path via a JSON round-trip. */
const throughFile = (snap: Snapshot): Snapshot => JSON.parse(JSON.stringify(snap));

// How PickMatrix decides who occupies a cell (completed pick, else keeper).
const occupantId = (pick: ResolvedPick, completedId?: string) => completedId ?? pick.keeperPlayerId;

describe('Session save/restore — keeper persistence (the reported bug)', () => {
  it('keeper cells survive snapshot → JSON file → restore', () => {
    const snap = throughFile(snapshot(preDraftWithKeepers()));
    const patch = restoreState(snap, 1);

    expect(patch.cells!.get(cellKey(1, 1))?.keeperPlayerId).toBe(KEEP_A);
    expect(patch.cells!.get(cellKey(3, 1))?.keeperPlayerId).toBe(KEEP_B);
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
      [cellKey(1, 1), { round: 1, teamSlot: 1, keeperPlayerId: 'a1' }],
      [cellKey(2, 1), { round: 2, teamSlot: 1, keeperPlayerId: 'a2' }],
    ]);

    const out = remapCells(cells, oldPool, newPool);
    expect(out.get(cellKey(1, 1))?.keeperPlayerId).toBe('z9'); // remapped by name
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
    expect(patch.cells!.get(cellKey(3, 1))?.keeperPlayerId).toBe(KEEP_B);
  });
});
