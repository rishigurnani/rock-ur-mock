import { describe, it, expect, beforeEach } from 'vitest';
import { hydratePlayers, SNAPSHOT_SCHEMA, sessionSearchText, writeSessions, listSessions, type SessionRec } from '../sessions';
import type { Player } from '../../types';

const p = (name: string, bye?: number): Player =>
  ({ id: name, name, position: 'RB', team: 'FA', adp: 1, projPoints: 1, bye, tags: [] });

describe('sessions storage — pool dedup (localStorage v2)', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  });
  const rec = (id: string, players: Player[]): SessionRec => ({
    id, name: id, savedAt: 0, status: 'Setup',
    snap: { datasetId: 'fp-2026', players, config: { teamCount: 2, roundCount: 2, preset: 'snake', rosterSlots: {} }, modifiers: [], teams: [], humanSlot: 1, seed: 1, started: false, cells: [], picks: [] },
  });

  it('round-trips pools exactly while storing each base once + diffs', () => {
    const P1 = [p('A'), p('B'), p('C')];
    const P2 = [p('A'), { ...p('B'), projPoints: 99 }, p('C')]; // 2/3 identical → diffs onto P1's base
    const P3 = [p('X'), p('Y'), p('Z')]; // 0% similar → its own base
    writeSessions([rec('r1', P1), rec('r2', P1), rec('r3', P2), rec('r4', P3)]);

    expect(listSessions().map((r) => r.snap.players)).toEqual([P1, P1, P2, P3]); // rehydrated exactly
    const stored = JSON.parse(store['rockurmock.sessions']);
    expect(stored.v).toBe(2);
    expect(stored.bases).toHaveLength(2); // P1-family + P3, not 4 full pools
    expect(stored.recs[0].snap.pool.changed).toHaveLength(0); // an identical pool stores nothing
    expect(stored.recs[2].snap.pool.changed).toHaveLength(1); // r3 keeps only the one changed player
  });

  it('still reads a legacy full-array log (backward compatible)', () => {
    store['rockurmock.sessions'] = JSON.stringify([rec('old', [p('A'), p('B')])]);
    expect(listSessions()[0].snap.players).toEqual([p('A'), p('B')]);
  });
});

describe('sessions snapshots', () => {
  it('stamps a positive schema version onto saves', () => {
    expect(SNAPSHOT_SCHEMA).toBeGreaterThan(0);
  });

  it('backfills only missing byes, never clobbering a saved value', () => {
    const out = hydratePlayers([p('A', 9), p('__no_such_player__')], 'fp-2026');
    expect(out[0].bye).toBe(9); // saved value preserved
    expect(out[1].bye).toBeUndefined(); // unknown name → nothing to fill
  });

  it('falls back to the default pool for an unknown dataset id', () => {
    expect(() => hydratePlayers([p('A')], 'upload-gone')).not.toThrow();
  });

  it('sessionSearchText indexes seat, pool, and only YOUR players', () => {
    // 2-team snake, 1 round: overall 1 → slot 1 (you), overall 2 → slot 2.
    const rec = {
      id: 'x', name: 'My Draft', savedAt: 0, status: 'complete',
      snap: {
        datasetId: 'fp-2026', players: [p('Cam Ward'), p('Josh Allen')], modifiers: [], teams: [],
        humanSlot: 1, seed: 1, started: true, cells: [], picks: ['Cam Ward', 'Josh Allen'],
        config: { teamCount: 2, roundCount: 1, preset: 'snake', rosterSlots: {} },
      },
    } as SessionRec;
    const text = sessionSearchText(rec);
    expect(text).toContain('cam ward'); // drafted onto your team
    expect(text).not.toContain('josh allen'); // opponent's pick — excluded
    expect(text).toContain('slot 1');
    expect(text).toContain('fp-2026');
  });
});
