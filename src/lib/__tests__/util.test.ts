import { describe, it, expect } from 'vitest';
import { indexById, range1, playerMeta, matchesQuery } from '../util';
import type { Player } from '../../types';

const mk = (p: Partial<Player>): Player => ({
  id: 'p', name: 'Name', position: 'RB', team: 'ATL', adp: 1, projPoints: 100, tags: [], ...p,
});

describe('util', () => {
  it('indexById maps items by id', () => {
    const m = indexById([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    expect(m.get('b')?.n).toBe(2);
    expect(m.size).toBe(2);
  });

  it('range1 yields [1..n]', () => {
    expect(range1(3)).toEqual([1, 2, 3]);
    expect(range1(0)).toEqual([]);
  });

  it('playerMeta joins team, bye, and rookie marker; omits absent parts', () => {
    expect(playerMeta(mk({ team: 'KC', bye: 9, tags: ['Rookie'] }))).toBe('KC · Bye 9 · R');
    expect(playerMeta(mk({ team: 'SF', bye: undefined, tags: ['Veteran'] }))).toBe('SF');
  });

  it('matchesQuery filters by name, position, team, bye, and tag (all tokens must match)', () => {
    const p = mk({ name: 'Bijan Robinson', position: 'RB', team: 'ATL', bye: 5, tags: ['Rookie'] });
    expect(matchesQuery(p, ['rb'])).toBe(true); // position filter via search
    expect(matchesQuery(p, ['bye5'])).toBe(true); // bye
    expect(matchesQuery(p, ['bijan', 'atl'])).toBe(true); // name + team
    expect(matchesQuery(p, ['qb'])).toBe(false);
    expect(matchesQuery(p, ['bijan', 'qb'])).toBe(false); // one token fails → excluded
    expect(matchesQuery(p, [])).toBe(true); // empty query matches everything
  });
});
