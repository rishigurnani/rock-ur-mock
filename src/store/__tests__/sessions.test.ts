import { describe, it, expect } from 'vitest';
import { hydratePlayers, SNAPSHOT_SCHEMA } from '../sessions';
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
});
