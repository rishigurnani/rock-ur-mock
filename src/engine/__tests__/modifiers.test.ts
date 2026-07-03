import { describe, it, expect } from 'vitest';
import { applyModifiers, rosterMaxByMatch, violatesRosterMax } from '../modifiers';
import type { Modifier, Player } from '../../types';

const players: Player[] = [
  { id: 'te1', name: 'TE One', position: 'TE', team: 'X', adp: 40, projPoints: 100, tags: ['Veteran'] },
  { id: 'qb1', name: 'QB One', position: 'QB', team: 'X', adp: 20, projPoints: 400, tags: ['Veteran'] },
  { id: 'rk1', name: 'Rook', position: 'WR', team: 'X', adp: 50, projPoints: 200, tags: ['Rookie'] },
];

describe('Universal Modifier Engine', () => {
  it('applies TE-premium score multiplier', () => {
    const mods: Modifier[] = [
      { id: 'm1', matchTag: 'TE', action: 'score_mult', params: { factor: 1.5 }, priority: 0, enabled: true },
    ];
    const eff = applyModifiers(players, mods);
    expect(eff.find((p) => p.id === 'te1')!.effProjPoints).toBe(150);
    expect(eff.find((p) => p.id === 'qb1')!.effProjPoints).toBe(400);
  });

  it('boosts rookie ADP (lower number = earlier)', () => {
    const mods: Modifier[] = [
      { id: 'm1', matchTag: 'Rookie', action: 'adp_boost', params: { pct: 0.2 }, priority: 0, enabled: true },
    ];
    const eff = applyModifiers(players, mods);
    expect(eff.find((p) => p.id === 'rk1')!.effAdp).toBeCloseTo(40);
  });

  it('ignores disabled modifiers', () => {
    const mods: Modifier[] = [
      { id: 'm1', matchTag: 'TE', action: 'score_mult', params: { factor: 1.5 }, priority: 0, enabled: false },
    ];
    const eff = applyModifiers(players, mods);
    expect(eff.find((p) => p.id === 'te1')!.effProjPoints).toBe(100);
  });

  it('enforces Superflex roster_max cap', () => {
    const mods: Modifier[] = [
      { id: 'm1', matchTag: 'QB', action: 'roster_max', params: { limit: 2 }, priority: 0, enabled: true },
    ];
    const caps = rosterMaxByMatch(mods);
    expect(violatesRosterMax(players[1], { QB: 1 }, caps)).toBe(false);
    expect(violatesRosterMax(players[1], { QB: 2 }, caps)).toBe(true);
  });
});
