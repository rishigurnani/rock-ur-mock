import { describe, it, expect } from 'vitest';
import { optimizeLineup, unfilledStarterCount } from '../roster';
import type { Player } from '../../types';

const mk = (id: string, position: Player['position'], projPoints: number): Player => ({
  id, name: id, position, team: 'X', adp: 1, projPoints, tags: [],
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

  it('unfilledStarterCount counts open slots incl. flex, from counts alone', () => {
    // Nothing drafted: 1+2+2+1+1(flex)+1+1 = 9 open starting slots.
    expect(unfilledStarterCount({ QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }, SLOTS)).toBe(9);
    // Overflow RB fills the FLEX: QB+2RB+extra WRs etc.
    expect(unfilledStarterCount({ QB: 1, RB: 3, WR: 2, TE: 1, K: 1, DST: 1 }, SLOTS)).toBe(0);
  });
});
