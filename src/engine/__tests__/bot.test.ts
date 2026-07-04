import { describe, it, expect } from 'vitest';
import { scoreCandidates, PRESETS, type SelectContext } from '../bot';
import type { EffectivePlayer } from '../modifiers';
import { DEFAULT_LEAGUE } from '../../data/presets';
import type { Brain } from '../../types';

const eff = (p: Partial<EffectivePlayer> & Pick<EffectivePlayer, 'id' | 'position'>): EffectivePlayer => ({
  name: p.id!,
  team: 'X',
  tags: ['Veteran'],
  adp: p.adp ?? 50,
  projPoints: p.projPoints ?? 200,
  effAdp: p.adp ?? 50,
  effProjPoints: p.projPoints ?? 200,
  ...p,
});

const POOL: EffectivePlayer[] = [
  eff({ id: 'qbA', position: 'QB', adp: 50, projPoints: 380 }),
  eff({ id: 'qbB', position: 'QB', adp: 52, projPoints: 360 }),
  eff({ id: 'rbA', position: 'RB', adp: 51, projPoints: 250 }),
  eff({ id: 'rbB', position: 'RB', adp: 53, projPoints: 240 }),
];

// totalPlayerPool chosen so currentPick = totalPlayerPool - available.length + 1 = 100.
const baseCtx = (roundCount: number): SelectContext => ({
  available: POOL,
  roster: { counts: { QB: 1, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 } },
  positionCounts: { QB: 1 }, // already have the QB starter → any QB is a backup
  config: { ...DEFAULT_LEAGUE, teamCount: 10, roundCount },
  modifiers: [],
  totalPlayerPool: 103,
  picksLeft: 5,
  rng: () => 0.5, // neutralizes the chaos roll (→ ×1)
});

const scoreOf = (brain: Brain, ctx: SelectContext, id: string) =>
  scoreCandidates(brain, ctx).find((c) => c.player.id === id)!.finalScore;

describe('early backup QB/TE penalty', () => {
  const brain = PRESETS.balanced;

  // currentPick is fixed at 100; only roundCount (hence draft fraction) changes.
  //   roundCount 20 → 100/200 = 0.50 < 0.67 → penalty applies
  //   roundCount 12 → 100/120 = 0.83 ≥ 0.67 → no penalty
  it('halves a backup QB drafted in the first 67% of the draft', () => {
    const early = scoreOf(brain, baseCtx(20), 'qbA');
    const late = scoreOf(brain, baseCtx(12), 'qbA');
    expect(early / late).toBeCloseTo(0.5, 5);
  });

  it('does not penalize a non-backup position (RB starter still open)', () => {
    const early = scoreOf(brain, baseCtx(20), 'rbA');
    const late = scoreOf(brain, baseCtx(12), 'rbA');
    expect(early).toBeCloseTo(late, 5);
  });
});
