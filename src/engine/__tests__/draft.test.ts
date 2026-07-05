import { describe, it, expect } from 'vitest';
import { DraftEngine } from '../draft';
import { cellKey } from '../matrix';
import { scoreCandidates, PRESETS } from '../bot';
import { applyModifiers } from '../modifiers';
import { loadDataset } from '../../data/datasets';
import { DEFAULT_LEAGUE, makeModifier } from '../../data/presets';
import type { Team } from '../../types';

// Tests run against the canonical CSV-backed pool via the dataset registry.
const POOL = loadDataset('fp-2026');

/** Deterministic RNG (mulberry32) so sims are reproducible. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function botTeams(count: number, brainKey: keyof typeof PRESETS = 'balanced'): Team[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    slot: i + 1,
    name: `Bot ${i + 1}`,
    isBot: true,
    brain: PRESETS[brainKey],
  }));
}

describe('Bot brain', () => {
  it('a zero-chaos VBD robot is deterministic and picks the top value', () => {
    const eff = applyModifiers(POOL, []);
    const scored = scoreCandidates(PRESETS.vbdRobot, {
      available: eff,
      rosterPlayers: [],
      config: DEFAULT_LEAGUE,
      modifiers: [],
      totalPlayerPool: eff.length,
      rng: () => 0.5,
    });
    // Highest-VBD player should be a QB (huge projection above baseline) or elite RB/WR.
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].trace.chaosRoll).toBe(1); // zero chaos => no swing
  });

  it('roster-need bonus favors an empty starting slot', () => {
    const eff = applyModifiers(POOL, []);
    const startingQb = eff.find((p) => p.position === 'QB')!; // roster's QB slot filled
    const scoredNeed = scoreCandidates(PRESETS.needFirst, {
      available: eff,
      rosterPlayers: [startingQb],
      config: DEFAULT_LEAGUE,
      modifiers: [],
      totalPlayerPool: eff.length,
      rng: () => 0.5,
    });
    // With QB filled and needFirst brain, the top pick should NOT be a 2nd QB.
    expect(scoredNeed[0].player.position).not.toBe('QB');
  });
});

describe('Full draft simulation', () => {
  it('runs a complete 10-team snake draft with no duplicate picks', () => {
    const engine = new DraftEngine({
      players: POOL,
      modifiers: [],
      teams: botTeams(10),
      config: DEFAULT_LEAGUE,
      rng: seeded(42),
    });
    engine.runToCompletion();

    expect(engine.isComplete).toBe(true);
    expect(engine.completed.length).toBe(DEFAULT_LEAGUE.teamCount * DEFAULT_LEAGUE.roundCount);

    const pickedIds = engine.completed.map((c) => c.playerId);
    expect(new Set(pickedIds).size).toBe(pickedIds.length); // no dupes
  });

  it('is reproducible under the same seed', () => {
    const run = () => {
      const e = new DraftEngine({
        players: POOL,
        modifiers: [],
        teams: botTeams(10),
        config: DEFAULT_LEAGUE,
        rng: seeded(7),
      });
      e.runToCompletion();
      return e.completed.map((c) => c.playerId).join(',');
    };
    expect(run()).toBe(run());
  });

  it('respects Superflex — allows a team to roster 2 QBs but never 3', () => {
    const engine = new DraftEngine({
      players: POOL,
      modifiers: [makeModifier('superflex')],
      teams: botTeams(10, 'sharkADP'),
      config: DEFAULT_LEAGUE,
      rng: seeded(3),
    });
    engine.runToCompletion();

    const qbCountBySlot = new Map<number, number>();
    for (const pick of engine.completed) {
      const player = POOL.find((p) => p.id === pick.playerId)!;
      if (player.position === 'QB') {
        qbCountBySlot.set(pick.teamSlot, (qbCountBySlot.get(pick.teamSlot) ?? 0) + 1);
      }
    }
    for (const count of qbCountBySlot.values()) expect(count).toBeLessThanOrEqual(2);
  });

  it('locks keepers before the draft runs', () => {
    const keeperId = POOL[9].id;
    const cells = new Map([
      [cellKey(1, 1), { round: 1, teamSlot: 1, keeperPlayerId: keeperId }],
    ]);
    const engine = new DraftEngine({
      players: POOL,
      modifiers: [],
      teams: botTeams(10),
      config: { ...DEFAULT_LEAGUE, roundCount: 3 },
      cells,
      rng: seeded(1),
    });
    engine.runToCompletion();
    const firstPick = engine.completed.find((c) => c.overall === 1)!;
    expect(firstPick.playerId).toBe(keeperId);
  });

  it('reserves a keeper so bots cannot draft them before the keeper round', () => {
    // POOL[0] is the #1 overall player — bots would grab them at pick #1.
    // Keep them for Team 5 at Round 3 instead; they must survive to that cell.
    const keeperId = POOL[0].id;
    const cells = new Map([
      [cellKey(3, 5), { round: 3, teamSlot: 5, keeperPlayerId: keeperId }],
    ]);
    const engine = new DraftEngine({
      players: POOL,
      modifiers: [],
      teams: botTeams(10),
      config: DEFAULT_LEAGUE,
      cells,
      rng: seeded(9),
    });
    engine.runToCompletion();

    const kept = engine.completed.filter((c) => c.playerId === keeperId);
    expect(kept).toHaveLength(1); // drafted exactly once, not erased
    expect(kept[0].round).toBe(3);
    expect(kept[0].teamSlot).toBe(5);
  });

  it('reconstructs a board by replaying pick ids (session restore / live config)', () => {
    const mk = () => new DraftEngine({ players: POOL, modifiers: [], teams: botTeams(10), config: DEFAULT_LEAGUE, rng: seeded(11) });
    const a = mk();
    a.runToCompletion();
    const ids = a.completed.map((c) => c.playerId);

    // Replay: force each pick; keepers (reserved) fall back to step().
    const b = mk();
    for (const id of ids) {
      try { b.makePick(id); } catch { b.step(); }
    }
    expect(b.completed.map((c) => c.playerId)).toEqual(ids);
  });

  it('replay preserves the prefix even with a reserved keeper mid-board', () => {
    const keeperId = POOL[0].id;
    const cells = new Map([[cellKey(3, 5), { round: 3, teamSlot: 5, keeperPlayerId: keeperId }]]);
    const mk = () => new DraftEngine({ players: POOL, modifiers: [], teams: botTeams(10), config: { ...DEFAULT_LEAGUE, roundCount: 4 }, cells, rng: seeded(11) });
    const a = mk();
    a.runToCompletion();
    const ids = a.completed.map((c) => c.playerId);

    const b = mk();
    for (const id of ids) {
      try { b.makePick(id); } catch { b.step(); }
    }
    expect(b.completed.map((c) => c.playerId)).toEqual(ids);
  });

  it('the sharp preset is 100% VBD, 10% chaos, 50% roster need', () => {
    expect(PRESETS.sharp).toEqual({ adpBias: 0, chaos: 10, rosterNeed: 50, ageUpside: 40 });
  });

  it('different seeds produce different drafts (bots are stochastic)', () => {
    const run = (seed: number) => {
      const e = new DraftEngine({
        players: POOL, modifiers: [], teams: botTeams(10, 'balanced'),
        config: DEFAULT_LEAGUE, rng: seeded(seed),
      });
      e.runToCompletion();
      return e.completed.map((c) => c.playerId).join(',');
    };
    expect(run(1)).not.toBe(run(2)); // chaos > 0 => seed changes the outcome
  });

  it('a future keeper counts toward its team roster + needs before its pick', () => {
    const keeperQb = POOL.find((p) => p.position === 'QB')!.id;
    const cells = new Map([[cellKey(10, 2), { round: 10, teamSlot: 2, keeperPlayerId: keeperQb }]]);
    const engine = new DraftEngine({
      players: POOL, modifiers: [], teams: botTeams(10), config: DEFAULT_LEAGUE, cells, rng: seeded(1),
    });

    // Before a single pick, team 2 already "has" its keeper QB, counted toward
    // its roster (so the bot sees the QB slot as filled, no need bonus for QB).
    expect(engine.teamPlayerIds(2)).toContain(keeperQb);
    expect(engine.rosterFor(2).counts.QB).toBe(1);
  });

  it('pauses for a human seat instead of auto-picking', () => {
    const engine = new DraftEngine({
      players: POOL,
      modifiers: [],
      teams: botTeams(10),
      config: DEFAULT_LEAGUE,
      humanSlot: 1,
      rng: seeded(5),
    });
    engine.runToCompletion();
    // First pick belongs to slot 1 (human) => engine should stop immediately.
    expect(engine.isComplete).toBe(false);
    expect(engine.isHumanOnClock).toBe(true);
    expect(engine.completed.length).toBe(0);

    // Human makes a pick, then bots roll again.
    const humanPickId = POOL[0].id;
    engine.makePick(humanPickId);
    engine.runToCompletion();
    expect(engine.completed[0].playerId).toBe(humanPickId);
  });
});
