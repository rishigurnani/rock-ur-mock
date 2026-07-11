import { describe, it, expect } from 'vitest';
import { resolvePickOrder, rollKeepers, cellKey, keptPlayerId, draftHorizon, type ResolveOptions } from '../matrix';
import type { MatrixCell } from '../../types';
import { CellKey } from '../matrix';
import { mulberry32 as seededRng } from '../../lib/util';

// A 3-team, 2-round snake board; override any field (preset, rounds, cells, …).
const order = (over: Partial<ResolveOptions> = {}) =>
  resolvePickOrder({ teamCount: 3, roundCount: 2, preset: 'snake', defaultTimerSeconds: 60, ...over });

describe('Pick Matrix resolver', () => {
  it('produces a linear order', () => {
    const picks = order({ preset: 'linear' });
    expect(picks.map((p) => p.teamSlot)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(picks.map((p) => p.overall)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reverses even rounds for snake', () => {
    const picks = order({ roundCount: 3 });
    // R1: 1,2,3  R2: 3,2,1  R3: 1,2,3
    expect(picks.map((p) => p.teamSlot)).toEqual([1, 2, 3, 3, 2, 1, 1, 2, 3]);
  });

  it('honors a traded pick via assignedTeamSlot', () => {
    const cells = new Map<CellKey, MatrixCell>([
      [cellKey(2, 3), { round: 2, teamSlot: 3, assignedTeamSlot: 1 }],
    ]);
    const picks = order({ cells });
    // Snake R2 order is slots 3,2,1; the slot-3 cell is owned by team 1.
    const r2 = picks.filter((p) => p.round === 2);
    expect(r2.find((p) => p.teamSlot === 3)!.owningTeamSlot).toBe(1);
  });

  it('applies per-cell timers and keepers', () => {
    const cells = new Map<CellKey, MatrixCell>([
      [cellKey(1, 1), { round: 1, teamSlot: 1, timerSeconds: 120, keepers: [{ playerId: 'p5', prob: 1 }] }],
    ]);
    const picks = order({ teamCount: 2, roundCount: 1, cells });
    expect(picks[0].timerSeconds).toBe(120);
    expect(keptPlayerId(picks[0])).toBe('p5'); // lone candidate resolves to occupant
    expect(picks[1].timerSeconds).toBe(60);
  });
});

const won = (cell?: MatrixCell) => cell?.keepers?.[0]?.playerId;

describe('draftHorizon — keeper-aware next pick & pool depletion', () => {
  it('skips keeper slots for both remaining picks and the depletion horizon', () => {
    // 2-team, 3-round snake; team 1 owns overalls 1, 4, 5 — and 4 is a keeper.
    const cells = new Map<CellKey, MatrixCell>([
      [cellKey(2, 1), { round: 2, teamSlot: 1, keepers: [{ playerId: 'k', prob: 1 }] }],
    ]);
    const order = resolvePickOrder({ teamCount: 2, roundCount: 3, preset: 'snake', defaultTimerSeconds: 60, cells });
    const h = draftHorizon(order, 0, 1); // team 1 on the clock at overall 1
    expect(h.picksLeft).toBe(2); // overall 1 (now) + 5; the R2 keeper (overall 4) is not a draft pick
    expect(h.untilNext).toBe(2); // overalls 2 & 3 deplete the pool before team 1 drafts again at 5
  });
});

describe('rollKeepers (probabilistic keepers)', () => {
  const cells = () => new Map<CellKey, MatrixCell>([
    [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: 'certain', prob: 1 }] }],
    [cellKey(2, 1), { round: 2, teamSlot: 1, keepers: [{ playerId: 'maybe', prob: 0.5 }] }],
    [cellKey(3, 1), { round: 3, teamSlot: 1, keepers: [{ playerId: 'longshot', prob: 0 }] }],
  ]);

  it('always keeps prob-1, always releases prob-0, and re-rolls the rest', () => {
    const kept = rollKeepers(cells(), () => 0.9); // 0.9 not < 0.5 → maybe released
    expect(won(kept.get(cellKey(1, 1)))).toBe('certain');
    expect(won(kept.get(cellKey(2, 1)))).toBeUndefined(); // released
    expect(won(kept.get(cellKey(3, 1)))).toBeUndefined(); // prob 0
    const kept2 = rollKeepers(cells(), () => 0.1); // 0.1 < 0.5 → maybe kept
    expect(won(kept2.get(cellKey(2, 1)))).toBe('maybe');
  });

  it('picks one of several rival candidates by cumulative probability, or none', () => {
    const c = () => new Map<CellKey, MatrixCell>([
      [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: 'A', prob: 0.6 }, { playerId: 'B', prob: 0.3 }] }],
    ]);
    expect(won(rollKeepers(c(), () => 0.3).get(cellKey(1, 1)))).toBe('A'); // 0.3 < 0.6
    expect(won(rollKeepers(c(), () => 0.75).get(cellKey(1, 1)))).toBe('B'); // 0.6 ≤ 0.75 < 0.9
    expect(won(rollKeepers(c(), () => 0.95).get(cellKey(1, 1)))).toBeUndefined(); // ≥ 0.9 → nobody
  });

  it('a released cell drops its keepers but keeps other overrides', () => {
    const c = new Map<CellKey, MatrixCell>([
      [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: 'x', prob: 0 }], assignedTeamSlot: 2 }],
    ]);
    const cell = rollKeepers(c, () => 0.5).get(cellKey(1, 1))!;
    expect(cell.keepers).toBeUndefined();
    expect(cell.assignedTeamSlot).toBe(2); // traded-pick override survives
  });

  it('certain keepers consume no randomness (seed stays aligned with bot picks)', () => {
    let draws = 0;
    rollKeepers(
      new Map([[cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: 'c', prob: 1 }] }]]),
      () => { draws++; return 0.5; },
    );
    expect(draws).toBe(0);
  });
});

describe('rollKeepers — league cap (keeperCount)', () => {
  // `n` single-candidate keeper cells for team 1, each at probability `p`.
  const team = (probs: number[]) =>
    new Map<CellKey, MatrixCell>(
      probs.map((p, i) => [cellKey(i + 1, 1), { round: i + 1, teamSlot: 1, keepers: [{ playerId: `p${i}`, prob: p }] }]),
    );
  const kept = (m: Map<CellKey, MatrixCell>) => [...m.values()].filter((c) => c.keepers?.length).length;

  it('keeperCount 0 keeps nobody, even certain keepers', () => {
    expect(kept(rollKeepers(team([1, 1, 0.5]), () => 0.1, 0))).toBe(0);
  });

  it('with Knz >= Kmax, keeps EXACTLY Kmax on every roll', () => {
    for (let seed = 1; seed <= 25; seed++) {
      expect(kept(rollKeepers(team([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), seededRng(seed), 4))).toBe(4);
    }
  });

  it('normalizes a too-greedy board down so exactly Kmax is reachable', () => {
    // 6 certain keepers, cap 4: without scaling every roll keeps 6 and never hits 4.
    expect(kept(rollKeepers(team([1, 1, 1, 1, 1, 1]), seededRng(7), 4))).toBe(4);
  });

  it('normalizes a too-timid board up so the cap is reachable', () => {
    // 4 keepers at 0.1 (sum 0.4), cap 4: scaled up until all four can be kept.
    expect(kept(rollKeepers(team([0.1, 0.1, 0.1, 0.1]), seededRng(3), 4))).toBe(4);
  });

  it('with Knz < Kmax, rolls independently (the cap is unreachable)', () => {
    // 2 candidates under a cap of 4: no rejection, each rolls on its own prob.
    expect(kept(rollKeepers(team([1, 0]), () => 0.9, 4))).toBe(1); // only the certain one
  });

  it('enforces the cap per team, independently', () => {
    const cells = new Map<CellKey, MatrixCell>([
      ...team([0.5, 0.5]),
      [cellKey(1, 2), { round: 1, teamSlot: 2, keepers: [{ playerId: 'c', prob: 0.5 }] }],
      [cellKey(2, 2), { round: 2, teamSlot: 2, keepers: [{ playerId: 'd', prob: 0.5 }] }],
    ]);
    const out = rollKeepers(cells, seededRng(3), 1);
    const perTeam = (slot: number) => [...out.values()].filter((c) => c.teamSlot === slot && c.keepers?.length).length;
    expect(perTeam(1)).toBe(1);
    expect(perTeam(2)).toBe(1);
  });
});
