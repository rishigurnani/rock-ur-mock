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

// Roster already holds a starting QB, so any pool QB is a backup.
const ROSTER = [eff({ id: 'rosterQB', position: 'QB', adp: 1, projPoints: 400 })];

// currentPick is pinned at 100 so only roundCount changes the draft fraction.
const baseCtx = (roundCount: number): SelectContext => ({
  available: POOL,
  rosterPlayers: ROSTER,
  config: { ...DEFAULT_LEAGUE, teamCount: 10, roundCount },
  modifiers: [],
  totalPlayerPool: 103,
  currentPick: 100,
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

describe('round-1/2 chaos cap keys off the true pick, not pool depletion', () => {
  // Deep-looking pool (as in a keeper league where keepers are pulled out up
  // front) must NOT trick the engine into thinking it's late in the draft.
  const ctx = (currentPick: number): SelectContext => ({
    available: POOL,
    rosterPlayers: [],
    config: { ...DEFAULT_LEAGUE, teamCount: 10 },
    modifiers: [],
    totalPlayerPool: 200,
    currentPick,
    rng: () => 1, // max positive chaos swing
  });
  // taco = chaos 100 → weight 0.4; capped at 0.1 in rounds 1-2.
  const chaosAt = (currentPick: number) =>
    scoreCandidates(PRESETS.taco, ctx(currentPick))[0].trace.chaosRoll;

  it('caps chaos at +10% at pick 5 (round 1)', () => {
    expect(chaosAt(5)).toBeCloseTo(1.1, 5);
  });

  it('allows full chaos once past round 2 (pick 30)', () => {
    expect(chaosAt(30)).toBeCloseTo(1.4, 5);
  });
});
