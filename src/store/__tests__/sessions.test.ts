import { describe, it, expect } from 'vitest';
import { hydratePlayers, SNAPSHOT_SCHEMA, sessionSearchText, type SessionRec } from '../sessions';
import type { Player } from '../../types';

const p = (name: string, bye?: number): Player =>
  ({ id: name, name, position: 'RB', team: 'FA', adp: 1, projPoints: 1, bye, tags: [] });

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
