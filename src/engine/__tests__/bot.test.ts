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

// One context builder for every test; overrides supply only what a case varies.
const mkCtx = (over: Partial<SelectContext> = {}): SelectContext => ({
  available: POOL,
  rosterPlayers: [],
  config: { ...DEFAULT_LEAGUE, teamCount: 10 },
  modifiers: [],
  totalPlayerPool: 103,
  currentPick: 100, // pinned so only roundCount moves the draft fraction
  picksLeft: 5,
  rng: () => 0.5, // neutralizes the chaos roll (→ ×1)
  ...over,
});

const scoreOf = (brain: Brain, ctx: SelectContext, id: string) =>
  scoreCandidates(brain, ctx).find((c) => c.player.id === id)!.finalScore;

describe('early backup QB/TE penalty', () => {
  const brain = PRESETS.balanced;
  const backupCtx = (roundCount: number) =>
    mkCtx({ rosterPlayers: ROSTER, config: { ...DEFAULT_LEAGUE, teamCount: 10, roundCount } });

  // currentPick is fixed at 100; only roundCount (hence draft fraction) changes.
  //   roundCount 20 → 100/200 = 0.50 < 0.67 → penalty applies
  //   roundCount 12 → 100/120 = 0.83 ≥ 0.67 → no penalty
  it('halves a backup QB drafted in the first 67% of the draft', () => {
    expect(scoreOf(brain, backupCtx(20), 'qbA') / scoreOf(brain, backupCtx(12), 'qbA')).toBeCloseTo(0.5, 5);
  });

  it('does not penalize a non-backup position (RB starter still open)', () => {
    expect(scoreOf(brain, backupCtx(20), 'rbA')).toBeCloseTo(scoreOf(brain, backupCtx(12), 'rbA'), 5);
  });
});

describe('round-1/2 chaos cap keys off the true pick, not pool depletion', () => {
  // Deep-looking pool (as in a keeper league where keepers are pulled out up
  // front) must NOT trick the engine into thinking it's late in the draft.
  // taco = chaos 100 → weight 0.4; capped at 0.1 in rounds 1-2. rng()=1 = max swing.
  const chaosAt = (currentPick: number) =>
    scoreCandidates(PRESETS.taco, mkCtx({ totalPlayerPool: 200, currentPick, rng: () => 1 }))[0].trace.chaosRoll;

  it('caps chaos at +10% at pick 5 (round 1)', () => {
    expect(chaosAt(5)).toBeCloseTo(1.1, 5);
  });

  it('allows full chaos once past round 2 (pick 30)', () => {
    expect(chaosAt(30)).toBeCloseTo(1.4, 5);
  });
});
