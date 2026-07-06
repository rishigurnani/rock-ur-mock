import { describe, it, expect } from 'vitest';
import type { Player, MatrixCell, LeagueConfig } from '../types';

// Contract tests: these only compile if the public domain types carry the
// fields the app relies on, and assert their runtime shape too.
describe('domain type contracts', () => {
  it('Player carries an optional bye week', () => {
    const p: Player = { id: 'x', name: 'X', position: 'RB', team: 'ATL', adp: 1, projPoints: 100, bye: 9, tags: ['Rookie'] };
    expect(p.bye).toBe(9);
    const noBye: Player = { id: 'y', name: 'Y', position: 'WR', team: 'SF', adp: 2, projPoints: 90, tags: [] };
    expect(noBye.bye).toBeUndefined();
  });

  it('MatrixCell carries keeper candidates with probabilities', () => {
    const c: MatrixCell = { round: 1, teamSlot: 1, keepers: [{ playerId: 'p5', prob: 0.5 }, { playerId: 'p6', prob: 0.3 }] };
    expect(c.keepers).toHaveLength(2);
    expect(c.keepers![0].prob).toBe(0.5);
  });

  it('LeagueConfig carries an optional keeper cap', () => {
    const cfg: LeagueConfig = { teamCount: 10, roundCount: 15, preset: 'snake', rosterSlots: { QB: 1 }, keeperCount: 2 };
    expect(cfg.keeperCount).toBe(2);
  });
});
