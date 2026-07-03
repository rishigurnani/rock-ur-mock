import { describe, it, expect } from 'vitest';
import { resolvePickOrder, cellKey } from '../matrix';
import type { MatrixCell } from '../../types';
import { CellKey } from '../matrix';

describe('Pick Matrix resolver', () => {
  it('produces a linear order', () => {
    const picks = resolvePickOrder({
      teamCount: 3,
      roundCount: 2,
      preset: 'linear',
      defaultTimerSeconds: 60,
    });
    expect(picks.map((p) => p.teamSlot)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(picks.map((p) => p.overall)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reverses even rounds for snake', () => {
    const picks = resolvePickOrder({
      teamCount: 3,
      roundCount: 3,
      preset: 'snake',
      defaultTimerSeconds: 60,
    });
    // R1: 1,2,3  R2: 3,2,1  R3: 1,2,3
    expect(picks.map((p) => p.teamSlot)).toEqual([1, 2, 3, 3, 2, 1, 1, 2, 3]);
  });

  it('honors a traded pick via assignedTeamSlot', () => {
    const cells = new Map<CellKey, MatrixCell>([
      [cellKey(2, 3), { round: 2, teamSlot: 3, assignedTeamSlot: 1 }],
    ]);
    const picks = resolvePickOrder({
      teamCount: 3,
      roundCount: 2,
      preset: 'snake',
      defaultTimerSeconds: 60,
      cells,
    });
    // Snake R2 order is slots 3,2,1; the slot-3 cell is owned by team 1.
    const r2 = picks.filter((p) => p.round === 2);
    expect(r2.find((p) => p.teamSlot === 3)!.owningTeamSlot).toBe(1);
  });

  it('applies per-cell timers and keepers', () => {
    const cells = new Map<CellKey, MatrixCell>([
      [cellKey(1, 1), { round: 1, teamSlot: 1, timerSeconds: 120, keeperPlayerId: 'p5' }],
    ]);
    const picks = resolvePickOrder({
      teamCount: 2,
      roundCount: 1,
      preset: 'snake',
      defaultTimerSeconds: 60,
      cells,
    });
    expect(picks[0].timerSeconds).toBe(120);
    expect(picks[0].keeperPlayerId).toBe('p5');
    expect(picks[1].timerSeconds).toBe(60);
  });
});
