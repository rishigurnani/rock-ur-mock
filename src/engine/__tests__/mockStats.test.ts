import { describe, it, expect } from 'vitest';
import { mockStats, type MockInput } from '../mockStats';
import type { LeagueConfig, Player } from '../../types';

const P = (id: string, name: string): Player =>
  ({ id, name, position: 'RB', team: 'FA', adp: 1, projPoints: 100, tags: [] });
const CFG: LeagueConfig = { teamCount: 2, roundCount: 2, preset: 'snake', rosterSlots: { RB: 2 } };
// 2-team snake: overall 1 → slot 1, overalls 2-3 → slot 2, overall 4 → slot 1.
const mock = (over: Partial<MockInput>): MockInput =>
  ({ name: 'm', players: ['a', 'b', 'c', 'd'].map((x) => P(x, x.toUpperCase())), config: CFG, humanSlot: 1, cells: [], picks: [], ...over });

describe('mockStats (cross-draft aggregates)', () => {
  it('merges by name across pools, averages picks, and counts your exposure', () => {
    const m1 = mock({ picks: ['a', 'b', 'c', 'd'] }); // slot 1 owns picks 1 & 4 → A, D
    const m2 = mock({
      players: ['a2', 'b2', 'c2', 'd2'].map((x) => P(x, x[0].toUpperCase())), // same names, new ids
      humanSlot: 2, picks: ['b2', 'a2', 'd2', 'c2'], // slot 2 owns picks 2 & 3 → A, D again
    });
    const report = mockStats([m1, m2]);
    const by = (n: string) => report.players.find((s) => s.player.name === n)!;
    expect(report.players).toHaveLength(4); // name-merged, not 8 id-keyed rows
    expect(by('A')).toMatchObject({ yours: 2, avgPick: 1.5 }); // picks 1 and 2
    expect(by('D')).toMatchObject({ yours: 2, avgPick: 3.5 }); // picks 4 and 3
    expect(by('B').yours).toBe(0);
    expect(report.players[0].player.name).toBe('A'); // most-yours first, then earliest avg pick
    // Each draft's human keeps two 100-pt RBs → 200 starter pts, identical → σ 0.
    expect(report.starterMean).toBe(200);
    expect(report.starterStd).toBe(0);
    expect(report.starterMedian).toBe(200);
    // Seat 1 in one draft, seat 2 in the other.
    expect(report.yourSlots).toEqual([{ slot: 1, count: 1 }, { slot: 2, count: 1 }]);
  });

  it('treats keepers as off-board: excluded from the market', () => {
    const players = ['A', 'B', 'C', 'D'].map((nm, i) => ({ ...P(nm.toLowerCase(), nm), adp: i + 1 }));
    // Team 1 keeps A at R1; you are seat 2.
    const m = mock({
      players, humanSlot: 2, picks: ['a', 'b', 'c', 'd'],
      cells: [{ round: 1, teamSlot: 1, keepers: [{ playerId: 'a', prob: 1 }] }],
    });
    const rep = mockStats([m]);
    expect(rep.players.find((s) => s.player.name === 'A')).toBeUndefined(); // always kept → off the market
    expect(rep.players.find((s) => s.player.name === 'B')).toBeTruthy(); // B was drafted → present
  });

  it('counts times kept for a player who is also drafted elsewhere', () => {
    const ps = ['A', 'B', 'C', 'D'].map((nm) => P(nm.toLowerCase(), nm));
    const keptM = mock({ players: ps, picks: ['a', 'b', 'c', 'd'], cells: [{ round: 1, teamSlot: 1, keepers: [{ playerId: 'a', prob: 1 }] }] });
    const a = mockStats([keptM, mock({ players: ps, picks: ['a', 'b', 'c', 'd'] })]).players.find((s) => s.player.name === 'A')!;
    expect(a).toMatchObject({ kept: 1, avgPick: 1 }); // kept once, drafted once (avg over board picks only)
  });

  it('attributes a traded pick to its owning team', () => {
    const m = mock({
      humanSlot: 2, picks: ['a', 'b', 'c', 'd'],
      cells: [{ round: 1, teamSlot: 1, assignedTeamSlot: 2 }], // pick #1 traded to team 2
    });
    expect(mockStats([m]).players.find((s) => s.player.name === 'A')!.yours).toBe(1);
  });
});
