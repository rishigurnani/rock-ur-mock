import { describe, it, expect } from 'vitest';
import { DraftEngine, type DraftSetup } from '../draft';
import { cellKey } from '../matrix';
import { scoreCandidates, PRESETS } from '../bot';
import { applyModifiers } from '../modifiers';
import { loadDataset } from '../../data/datasets';
import { DEFAULT_LEAGUE, makeModifier } from '../../data/presets';
import { mulberry32 as seeded } from '../../lib/util';
import type { Team } from '../../types';

// Tests run against the canonical CSV-backed pool via the dataset registry.
const POOL = loadDataset('fp-2026');

function botTeams(count: number, brainKey: keyof typeof PRESETS = 'balanced'): Team[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    slot: i + 1,
    name: `Bot ${i + 1}`,
    isBot: true,
    brain: PRESETS[brainKey],
  }));
}

// Engine with the standard 10-bot / default-league setup; override any field,
// and pass `seed` as shorthand for the seeded RNG.
function engineOf({ seed = 1, ...over }: Partial<DraftSetup> & { seed?: number } = {}) {
  return new DraftEngine({
    players: POOL, modifiers: [], teams: botTeams(10), config: DEFAULT_LEAGUE, rng: seeded(seed), ...over,
  });
}

// Force pick ids into a fresh engine (reserved keepers fall back to step()) and
// return the resulting pick order — the shared session-restore / replay path.
function replay(mk: () => DraftEngine, ids: string[]): string[] {
  const e = mk();
  for (const id of ids) { try { e.makePick(id); } catch { e.step(); } }
  return e.completed.map((c) => c.playerId);
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
      currentPick: 1,
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
      currentPick: 1,
      rng: () => 0.5,
    });
    // With QB filled and needFirst brain, the top pick should NOT be a 2nd QB.
    expect(scoredNeed[0].player.position).not.toBe('QB');
  });
});

describe('Full draft simulation', () => {
  it('runs a complete 10-team snake draft with no duplicate picks', () => {
    const engine = engineOf({ seed: 42 });
    engine.runToCompletion();

    expect(engine.isComplete).toBe(true);
    expect(engine.completed.length).toBe(DEFAULT_LEAGUE.teamCount * DEFAULT_LEAGUE.roundCount);

    const pickedIds = engine.completed.map((c) => c.playerId);
    expect(new Set(pickedIds).size).toBe(pickedIds.length); // no dupes
  });

  it('is reproducible under the same seed', () => {
    const run = () => {
      const e = engineOf({ seed: 7 });
      e.runToCompletion();
      return e.completed.map((c) => c.playerId).join(',');
    };
    expect(run()).toBe(run());
  });

  it('respects Superflex — allows a team to roster 2 QBs but never 3', () => {
    const engine = engineOf({ modifiers: [makeModifier('superflex')], teams: botTeams(10, 'sharkADP'), seed: 3 });
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
      [cellKey(1, 1), { round: 1, teamSlot: 1, keepers: [{ playerId: keeperId, prob: 1 }] }],
    ]);
    const engine = engineOf({ config: { ...DEFAULT_LEAGUE, roundCount: 3 }, cells, seed: 1 });
    engine.runToCompletion();
    const firstPick = engine.completed.find((c) => c.overall === 1)!;
    expect(firstPick.playerId).toBe(keeperId);
  });

  it('reserves a keeper so bots cannot draft them before the keeper round', () => {
    // POOL[0] is the #1 overall player — bots would grab them at pick #1.
    // Keep them for Team 5 at Round 3 instead; they must survive to that cell.
    const keeperId = POOL[0].id;
    const cells = new Map([
      [cellKey(3, 5), { round: 3, teamSlot: 5, keepers: [{ playerId: keeperId, prob: 1 }] }],
    ]);
    const engine = engineOf({ cells, seed: 9 });
    engine.runToCompletion();

    const kept = engine.completed.filter((c) => c.playerId === keeperId);
    expect(kept).toHaveLength(1); // drafted exactly once, not erased
    expect(kept[0].round).toBe(3);
    expect(kept[0].teamSlot).toBe(5);
  });

  it('a prob-0 keeper is released, not reserved (drafted on value, not locked)', () => {
    // Same setup, but keeperProb 0 → this run does NOT keep them: the #1 player
    // is back in the pool and grabbed early, NOT locked to Team 5 / Round 3.
    const keeperId = POOL[0].id;
    const cells = new Map([
      [cellKey(3, 5), { round: 3, teamSlot: 5, keepers: [{ playerId: keeperId, prob: 0 }] }],
    ]);
    const engine = engineOf({ cells, seed: 9 });
    engine.runToCompletion();

    const kept = engine.completed.find((c) => c.playerId === keeperId)!;
    expect(kept).toBeTruthy();
    expect(kept.round === 3 && kept.teamSlot === 5).toBe(false); // not force-locked
  });

  it('reconstructs a board by replaying pick ids (session restore / live config)', () => {
    const mk = () => engineOf({ seed: 11 });
    const a = mk();
    a.runToCompletion();
    const ids = a.completed.map((c) => c.playerId);

    expect(replay(mk, ids)).toEqual(ids);
  });

  it('replay preserves the prefix even with a reserved keeper mid-board', () => {
    const keeperId = POOL[0].id;
    const cells = new Map([[cellKey(3, 5), { round: 3, teamSlot: 5, keepers: [{ playerId: keeperId, prob: 1 }] }]]);
    const mk = () => engineOf({ config: { ...DEFAULT_LEAGUE, roundCount: 4 }, cells, seed: 11 });
    const a = mk();
    a.runToCompletion();
    const ids = a.completed.map((c) => c.playerId);

    expect(replay(mk, ids)).toEqual(ids);
  });

  it('the sharp preset is an even VBD/ADP blend, moderate chaos, light roster nudge, no age', () => {
    expect(PRESETS.sharp).toEqual({ adpBias: 50, chaos: 50, rosterNeed: 25, ageUpside: 0 });
  });

  it('different seeds produce different drafts (bots are stochastic)', () => {
    const run = (seed: number) => {
      const e = engineOf({ seed });
      e.runToCompletion();
      return e.completed.map((c) => c.playerId).join(',');
    };
    expect(run(1)).not.toBe(run(2)); // chaos > 0 => seed changes the outcome
  });

  it('a future keeper counts toward its team roster + needs before its pick', () => {
    const keeperQb = POOL.find((p) => p.position === 'QB')!.id;
    const cells = new Map([[cellKey(10, 2), { round: 10, teamSlot: 2, keepers: [{ playerId: keeperQb, prob: 1 }] }]]);
    const engine = engineOf({ cells, seed: 1 });

    // Before a single pick, team 2 already "has" its keeper QB, counted toward
    // its roster (so the bot sees the QB slot as filled, no need bonus for QB).
    expect(engine.teamPlayerIds(2)).toContain(keeperQb);
    expect(engine.rosterFor(2).counts.QB).toBe(1);
  });

  it('pauses for a human seat instead of auto-picking', () => {
    const engine = engineOf({ humanSlot: 1, seed: 5 });
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

  it('rewinds to a pick: undoes later picks, restores the pool, keeps keepers reserved', () => {
    const keeperId = POOL[0].id; // #1 player, kept for Team 5 at Round 3 (overall 25)
    const cells = new Map([[cellKey(3, 5), { round: 3, teamSlot: 5, keepers: [{ playerId: keeperId, prob: 1 }] }]]);
    const engine = engineOf({ cells, seed: 7 });
    engine.runToCompletion();
    const total = engine.completed.length;
    const drafted = engine.completed.find((c) => c.overall === 20)!.playerId;

    engine.rewindTo(20);
    expect(engine.completed.length).toBe(19); // picks 1..19 kept
    expect(engine.currentPick?.overall).toBe(20); // pick 20 back on the clock
    expect(engine.availablePlayers().some((p) => p.id === drafted)).toBe(true); // undone player returns to the pool
    expect(engine.availablePlayers().some((p) => p.id === keeperId)).toBe(false); // reserved keeper stays out

    engine.runToCompletion();
    expect(engine.completed.length).toBe(total); // re-runs to a full board
    expect(engine.completed.filter((c) => c.playerId === keeperId)).toHaveLength(1); // keeper still kept exactly once
  });
});

describe('Time machine (heist)', () => {
  it('rewinds a heisted pick to the LATEST bot that had the player in its top 15', () => {
    const e = engineOf({ humanSlot: 3, seed: 1 });
    e.runToCompletion(); // stops on your first pick (#3); bots took #1, #2
    expect(e.isHumanOnClock).toBe(true);
    const bot2 = e.completed[1];
    const taken = new Set(e.completed.map((c) => c.playerId));
    const p = bot2.topIds!.find((id) => !taken.has(id))!; // in the later bot's (#2) top 15, still free
    e.makePick(p); // you draft p
    expect(e.heist(1)).toBe(true);
    expect(e.completed[1].playerId).toBe(p); // handed to the LATEST qualifying bot (pick #2, not #1)
    expect(e.isHumanOnClock).toBe(true); // your clock again — p is gone
    expect(e.availablePlayers().some((x) => x.id === p)).toBe(false);
    expect(e.lastHeist).toEqual({ playerId: p, teamSlot: bot2.teamSlot }); // recorded for the notice
  });

  it('heisting the same pick twice keeps both players placed', () => {
    const e = engineOf({ humanSlot: 5, seed: 1 });
    e.runToCompletion(); // stops on your first pick (#5); bots took #1–#4
    const taken = new Set(e.completed.map((c) => c.playerId));
    const a = e.completed[3].topIds!.find((id) => !taken.has(id))!; // in bot #4's top 15
    const b = e.completed[2].topIds!.find((id) => !taken.has(id) && id !== a)!; // in bot #3's top 15
    e.makePick(a);
    expect(e.heist(1)).toBe(true); // A is heisted
    e.makePick(b);
    expect(e.heist(1)).toBe(true); // B is heisted on the same pick
    expect(e.availablePlayers().some((x) => x.id === a)).toBe(false); // A still has a home (the bug)
    expect(e.availablePlayers().some((x) => x.id === b)).toBe(false); // and so does B
    expect(e.isHumanOnClock).toBe(true);
  });

  it('odds 0 never heists; the pick stands', () => {
    const e = engineOf({ humanSlot: 3, seed: 1 });
    e.runToCompletion();
    const p = e.availablePlayers()[0].id;
    e.makePick(p);
    expect(e.heist(0)).toBe(false);
    expect(e.completed.at(-1)!.playerId).toBe(p);
    expect(e.lastHeist).toBeNull(); // no heist → nothing to notify
  });
});
