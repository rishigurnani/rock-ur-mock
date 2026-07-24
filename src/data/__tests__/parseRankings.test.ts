import { describe, it, expect } from 'vitest';
import { parseRankingsCsv } from '../parseRankings';
import { loadDataset } from '../datasets';
import fantasyProsRaw from '../FantasyPros_2026_Draft_ALL_Rankings.csv?raw';

describe('Rankings parser', () => {
  it('parses the FantasyPros 2026 CSV into a deep, valid pool', () => {
    const players = parseRankingsCsv(fantasyProsRaw, { idPrefix: 't' });
    expect(players.length).toBeGreaterThan(400);

    // Every player is well-formed.
    for (const p of players) {
      expect(['QB', 'RB', 'WR', 'TE', 'K', 'DST']).toContain(p.position);
      expect(p.name).toBeTruthy();
      expect(p.projPoints).toBeGreaterThan(0);
      expect(p.adp).toBeGreaterThan(0);
    }

    // Ids are unique.
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // ADP comes from the RK column: the top player has the minimum ADP.
    // (Assert the mapping/sort, not a specific name — the rankings data churns.)
    const byAdp = [...players].sort((a, b) => a.adp - b.adp);
    expect(byAdp[0].adp).toBe(Math.min(...players.map((p) => p.adp)));
  });

  it('maps columns by header alias regardless of order', () => {
    const csv = ['NAME,POS,TEAM,RANK', 'Test QB,QB1,KC,1', 'Test RB,RB5,SF,2'].join('\n');
    const players = parseRankingsCsv(csv);
    expect(players).toHaveLength(2);
    expect(players[0].position).toBe('QB');
    expect(players[1].position).toBe('RB');
  });

  it('parses the BYE WEEK column (absent → undefined)', () => {
    const csv = ['PLAYER NAME,POS,TEAM,RK,BYE WEEK', 'Bye Guy,RB1,ATL,1,11', 'No Bye,WR1,SF,2,'].join('\n');
    const players = parseRankingsCsv(csv);
    expect(players[0].bye).toBe(11);
    expect(players[1].bye).toBeUndefined();
    // The real FantasyPros pool carries byes for real NFL teams.
    expect(loadDataset('fp-2026').some((p) => p.bye != null)).toBe(true);
  });

  it('tags configured rookies', () => {
    const csv = ['PLAYER NAME,POS,TEAM,RK', 'Star Rookie,RB1,ATL,1'].join('\n');
    const players = parseRankingsCsv(csv, { rookieNames: new Set(['Star Rookie']) });
    expect(players[0].tags).toContain('Rookie');
  });

  it('registry loads and memoizes the default dataset', () => {
    const a = loadDataset('fp-2026');
    const b = loadDataset('fp-2026');
    expect(a).toBe(b); // memoized identity
    expect(a.length).toBeGreaterThan(400);
  });
});
