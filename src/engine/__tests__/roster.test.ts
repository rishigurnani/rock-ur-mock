import { describe, it, expect } from 'vitest';
import { optimizeLineup, marginalStartingValue, byeClashes } from '../roster';
import type { Player } from '../../types';

const mk = (id: string, position: Player['position'], projPoints: number, bye?: number): Player => ({
  id, name: id, position, team: 'X', adp: 1, projPoints, bye, tags: [],
});

const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 2 };

describe('Lineup engine', () => {
  it('seats the best players and benches the rest, FLEX from best leftover', () => {
    const roster = [
      mk('qb1', 'QB', 300),
      mk('rb1', 'RB', 250), mk('rb2', 'RB', 240), mk('rb3', 'RB', 200),
      mk('wr1', 'WR', 230), mk('wr2', 'WR', 220),
      mk('te1', 'TE', 150),
      mk('k1', 'K', 120), mk('dst1', 'DST', 110),
    ];
    const lu = optimizeLineup(roster, SLOTS);

    // FLEX should take rb3 (200) — best leftover flex-eligible.
    const flex = lu.starters.find((s) => s.slot === 'FLEX');
    expect(flex?.player?.id).toBe('rb3');
    // No empty starting seats given a full roster.
    expect(lu.unfilled).toHaveLength(0);
    // Bench holds nobody here (exactly 9 starters for 9 players).
    expect(lu.bench).toHaveLength(0);
    expect(lu.startingPoints).toBe(300 + 250 + 240 + 230 + 220 + 150 + 200 + 120 + 110);
  });

  it('reports empty starting slots as unfilled needs', () => {
    const lu = optimizeLineup([mk('qb1', 'QB', 300)], SLOTS);
    expect(lu.unfilled).toContain('K');
    expect(lu.unfilled).toContain('DST');
    expect(lu.unfilled).toContain('RB');
  });

});

describe('marginalStartingValue (quality-aware roster need)', () => {
  it('adds a candidate at full value when it fills an empty starting slot', () => {
    const roster = [mk('qb1', 'QB', 300)]; // RB slots wide open
    expect(marginalStartingValue(roster, mk('rb', 'RB', 200), SLOTS)).toBe(200);
  });

  it('still sees need behind bench-caliber keepers, but ignores a scrub', () => {
    // Keeper league: three RBs already rostered, but all bench-caliber.
    const roster = [mk('rb1', 'RB', 120), mk('rb2', 'RB', 110), mk('rb3', 'RB', 100)];
    const base = optimizeLineup(roster, SLOTS).startingPoints;

    // A starting-caliber RB upgrades the lineup → real need, despite "enough" RBs.
    expect(marginalStartingValue(roster, mk('stud', 'RB', 260), SLOTS, base)).toBeGreaterThan(0);
    // A worse-than-everyone RB only rides the bench → zero need.
    expect(marginalStartingValue(roster, mk('scrub', 'RB', 80), SLOTS, base)).toBe(0);
  });
});

describe('byeClashes (bye-stack warnings)', () => {
  it('flags weeks shared by 2+ players, worst first, ignoring singletons/no-bye', () => {
    const players = [
      mk('a', 'RB', 100, 9), mk('b', 'WR', 100, 9), mk('c', 'TE', 100, 9), // 3 on bye 9
      mk('d', 'RB', 100, 5), mk('e', 'WR', 100, 5), // 2 on bye 5
      mk('f', 'QB', 100, 7), // lone bye 7
      mk('g', 'K', 100), // no bye
    ];
    expect(byeClashes(players)).toEqual([
      { week: 9, count: 3 },
      { week: 5, count: 2 },
    ]);
  });

  it('returns nothing when no bye is shared', () => {
    expect(byeClashes([mk('a', 'RB', 100, 5), mk('b', 'WR', 100, 6)])).toEqual([]);
  });
});
