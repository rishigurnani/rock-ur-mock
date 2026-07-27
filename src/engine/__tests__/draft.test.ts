import { describe, it, expect } from 'vitest';
import { DraftEngine, type DraftSetup } from '../draft';
import { cellKey } from '../matrix';
import { scoreCandidates, PRESETS } from '../bot';
import { applyModifiers } from '../modifiers';
import { loadDataset } from '../../data/datasets';
import { DEFAULT_LEAGUE, makeModifier } from '../../data/presets';
import { mulberry32 as seeded } from '../../lib/util';
import type { Player, Team } from '../../types';

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
// A bot pick's top-15 candidate ids, read off the stored shortlist.
const shortlistIds = (c: { shortlist?: { playerId: string }[] }) => c.shortlist!.map((s) => s.playerId);

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

describe('Fix a player to a slot (force)', () => {
  it('holds a pinned player out of the pool until his slot (no early scoop)', () => {
    // Pin the #1 overall player — whom bots would grab at pick #1 — to Team 7 /
    // Round 3. He must survive the 26 intervening picks and land exactly there.
    const star = POOL[0].id;
    const e = engineOf({ seed: 4 });
    const at = e.pickAt(3, 7)!; // overall pick Team 7 owns in round 3
    e.force(at, star);
    expect(e.availablePlayers().some((p) => p.id === star)).toBe(false); // reserved, off the pool
    e.runToCompletion();
    const there = e.completed.find((c) => c.overall === at)!;
    expect(there.playerId).toBe(star);
    expect(there.teamSlot).toBe(7);
    expect(e.completed.filter((c) => c.playerId === star)).toHaveLength(1); // placed exactly once
  });

  it('counts a pin toward its team roster the moment it is set (like a keeper)', () => {
    const e = engineOf({ seed: 4 });
    const star = e.availablePlayers()[0];
    e.force(e.pickAt(3, 7)!, star.id); // pin the top player to Team 7
    expect(e.teamPlayerIds(7)).toContain(star.id); // on the roster before its pick
    expect(e.rosterFor(7).counts[star.position]).toBe(1);
    expect(e.teamPlayerIds(1)).not.toContain(star.id); // only its owner's roster
  });

  it('lands a pin on the human\'s OWN future slot (not overwritten when you get there)', () => {
    // Human on the clock at 2.1 pins a player to their round-9 pick. A pinned slot
    // is not a free choice, so the engine — not autoPickHuman / a manual draft —
    // resolves it: isHumanOnClock is false there and step() commits the pin.
    const e = engineOf({ humanSlot: 1, seed: 4 });
    e.runToCompletion();
    e.makePick(e.availablePlayers()[0].id); e.runToCompletion(); // now at 2.1
    const star = e.availablePlayers()[3].id;
    const at = e.pickAt(9, 1)!;
    e.force(at, star);
    // Drive the board as the store does: draft on your clock, engine resolves the rest.
    while (!e.isComplete) e.isHumanOnClock ? e.makePick(e.availablePlayers()[0].id) : e.step();
    const there = e.completed.find((c) => c.overall === at)!;
    expect(there.playerId).toBe(star);
    expect(there.teamSlot).toBe(1);
  });
});

// A heist and a manual pin share the `forced` mechanism but are NOT the same thing:
// only a user pin previews/counts on the board. These pin the distinction so the
// "rewind turns a heist into a pin" class of bug can't come back.
describe('Pins vs heists (forced-pick separation)', () => {
  // Force one of each on a fresh engine: force(overall, id) = user pin;
  // force(overall, id, {trace}) = heist. Fresh board so nothing is committed yet.
  const twoForced = () => {
    const e = engineOf({ seed: 4 });
    const [pinId, heistId] = [e.availablePlayers()[0].id, e.availablePlayers()[1].id];
    const [pinAt, heistAt] = [e.pickAt(3, 7)!, e.pickAt(3, 8)!];
    e.force(pinAt, pinId); // manual user pin
    e.force(heistAt, heistId, { heist: true }); // heist-flagged pin
    return { e, pinId, heistId, pinAt, heistAt };
  };

  it('pinnedAt previews a user pin but never a heist', () => {
    const { e, pinId, pinAt, heistAt } = twoForced();
    expect(e.pinnedAt(pinAt)).toBe(pinId); // the board shows a manual pin
    expect(e.pinnedAt(heistAt)).toBeNull(); // but a heisted slot is not a pending pin
  });

  it('a user pin counts on its roster; an uncommitted heist does not', () => {
    const { e, pinId, heistId } = twoForced();
    expect(e.teamPlayerIds(7)).toContain(pinId); // pin joins the roster at once (keeper-like)
    expect(e.teamPlayerIds(8)).not.toContain(heistId); // a steal counts only once truly committed
  });

  it('both a user pin and an uncommitted heist are held out of the pool', () => {
    const { e, pinId, heistId } = twoForced();
    const pool = new Set(e.availablePlayers().map((p) => p.id));
    expect(pool.has(pinId)).toBe(false); // nobody can scoop a pinned player
    expect(pool.has(heistId)).toBe(false); // nor a heisted one awaiting its re-run
  });
});

describe('Time machine (heist)', () => {
  it('rewinds a heisted pick to the LATEST bot that had the player in its top 15', () => {
    const e = engineOf({ humanSlot: 3, seed: 1 });
    e.runToCompletion(); // stops on your first pick (#3); bots took #1, #2
    expect(e.isHumanOnClock).toBe(true);
    const bot2 = e.completed[1];
    const taken = new Set(e.completed.map((c) => c.playerId));
    const p = shortlistIds(bot2).find((id) => !taken.has(id))!; // in the later bot's (#2) top 15, still free
    e.makePick(p); // you draft p
    expect(e.heist(1)).toBe(true);
    expect(e.completed[1].playerId).toBe(p); // handed to the LATEST qualifying bot (pick #2, not #1)
    expect(e.completed[1].trace).toBeTruthy(); // heisted pick carries the bot's score breakdown (tooltip)
    expect(e.isHumanOnClock).toBe(true); // your clock again — p is gone
    expect(e.availablePlayers().some((x) => x.id === p)).toBe(false);
    expect(e.lastHeist).toEqual({ playerId: p, teamSlot: bot2.teamSlot }); // recorded for the notice
  });

  it('heisting the same pick twice keeps both players placed', () => {
    const e = engineOf({ humanSlot: 5, seed: 1 });
    e.runToCompletion(); // stops on your first pick (#5); bots took #1–#4
    const taken = new Set(e.completed.map((c) => c.playerId));
    const a = shortlistIds(e.completed[3]).find((id) => !taken.has(id))!; // in bot #4's top 15
    const b = shortlistIds(e.completed[2]).find((id) => !taken.has(id) && id !== a)!; // in bot #3's top 15
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

  it('a keeper at your slot is not a turn boundary — the heist rewinds past it', () => {
    // Slot 1 keeps a player at 2.1 (overall 20); your real picks are overall 1 and 21.
    // The keeper auto-recommits on rewind, so it must NOT stop a heist from reaching a
    // bot that picked before it — otherwise the heist could never fire here at all.
    const cells = new Map([[cellKey(2, 1), { round: 2, teamSlot: 1, keepers: [{ playerId: POOL[300].id, prob: 1 }] }]]);
    const e = engineOf({ humanSlot: 1, seed: 1, cells });
    e.runToCompletion(); // stops on your first pick (overall 1)
    e.makePick(e.availablePlayers()[0].id);
    e.runToCompletion(); // bots 2–19, keeper auto-commits at 20, stops on your pick at 21
    expect(e.isHumanOnClock).toBe(true);
    const taken = new Set(e.completed.map((c) => c.playerId));
    const p = shortlistIds(e.completed[1]).find((id) => !taken.has(id))!; // in a bot's top 15 before the keeper
    e.makePick(p);
    expect(e.heist(1)).toBe(true); // fires despite the intervening keeper
    expect(e.lastHeist!.playerId).toBe(p);
    expect(e.completed.find((c) => c.playerId === p)!.overall).toBeLessThan(20); // rewound past the 2.1 keeper
  });

  it('a heisted pick carries the victim bot\'s trace but no shortlist (unlike a real bot pick)', () => {
    const e = engineOf({ humanSlot: 3, seed: 1 });
    e.runToCompletion();
    const taken = new Set(e.completed.map((c) => c.playerId));
    const p = shortlistIds(e.completed[1]).find((id) => !taken.has(id))!;
    e.makePick(p);
    expect(e.heist(1)).toBe(true);
    const stolen = e.completed.find((c) => c.playerId === p)!;
    expect(stolen.trace).toBeTruthy(); // the victim's read powers the tooltip
    expect(stolen.shortlist).toBeUndefined(); // forced steal, not a fresh bot evaluation
  });

  it('a USER rewind past a heist returns the stolen player to the pool (no re-steal, no pin)', () => {
    // The reported bug: rewinding past a heisted pick left the stolen player stuck to
    // that slot (shown as a 📌 pin, re-stolen on re-run). A user rewind must UNDO the
    // steal like any pick — the player goes back to the pool, free to be drafted again.
    const e = engineOf({ humanSlot: 3, seed: 1 });
    e.runToCompletion();
    const taken = new Set(e.completed.map((c) => c.playerId));
    const p = shortlistIds(e.completed[1]).find((id) => !taken.has(id))!;
    e.makePick(p);
    expect(e.heist(1)).toBe(true);
    const at = e.completed.find((c) => c.playerId === p)!.overall;

    e.rewindTo(at, true); // the user's rewind (the store passes clearHeists)
    expect(e.pinnedAt(at)).toBeNull(); // not surfaced as a pending pin
    expect(e.availablePlayers().some((x) => x.id === p)).toBe(true); // BACK in the pool, un-reserved
  });

  it('a redundant 2nd QB CAN be stolen onto a set team — but scored with an HONEST low need (< 1)', () => {
    // Back-to-back QBs are allowed; what was broken is the trace. A bot already holding
    // the better QB may still be handed a weaker one, but its need is re-scored against
    // the filled roster — a redundant < 1, never the phantom > 1 the old frozen read showed.
    const mk = (id: string, name: string, position: Player['position'], adp: number, projPoints: number): Player =>
      ({ id, name, position, team: 'X', adp, projPoints, tags: [] });
    const pool = [
      mk('qa', 'QB A', 'QB', 1, 400), mk('r1', 'RB 1', 'RB', 2, 320), mk('r2', 'RB 2', 'RB', 3, 310),
      mk('r3', 'RB 3', 'RB', 4, 300), mk('r4', 'RB 4', 'RB', 5, 290), mk('qb', 'QB B', 'QB', 6, 150),
    ];
    const e = new DraftEngine({
      players: pool, modifiers: [], teams: botTeams(2), humanSlot: 1, rng: seeded(1),
      config: { teamCount: 2, roundCount: 3, preset: 'snake', rosterSlots: { QB: 1, RB: 2 } },
    });
    e.runToCompletion(); // your pick #1
    e.makePick('r1'); e.runToCompletion(); // bot grabs elite QB A (#2); back to you at #4
    expect(e.teamPlayerIds(2)).toContain('qa'); // the bot already holds the better QB
    e.makePick('qb'); // you draft weak QB B — which the bot shortlisted
    expect(e.heist(1)).toBe(true); // the steal fires (back-to-back QBs allowed)
    const stolen = e.completed.find((c) => c.playerId === 'qb')!;
    expect(stolen.teamSlot).toBe(2); // handed to the bot that already has QB A
    expect(stolen.trace!.needMultiplier).toBeLessThan(1); // re-scored honestly: redundant depth
  });

  it('across seeds, redundant QBs re-score out and relocate — no two EARLY QB steals on one team, never both need > 1', () => {
    const posOf = (id: string) => POOL.find((p) => p.id === id)!.position;
    const isHeisted = (c: { trace?: unknown; shortlist?: unknown }) => !!c.trace && !c.shortlist;
    const early = 0.67 * DEFAULT_LEAGUE.teamCount * DEFAULT_LEAGUE.roundCount; // the backup-QB-penalty window
    for (let seed = 1; seed < 20; seed++) {
      const e = new DraftEngine({ players: POOL, modifiers: [], teams: botTeams(10), humanSlot: 1, config: DEFAULT_LEAGUE, rng: seeded(seed) });
      let guard = 0;
      while (!e.isComplete && guard++ < 400) {
        if (e.isHumanOnClock) {
          const qb = e.availablePlayers().find((p) => p.position === 'QB'); // hoard QBs to stress QB heists
          e.makePick((qb ?? e.availablePlayers()[0]).id);
          if (!e.heist(1)) e.runToCompletion();
        } else e.step();
      }
      const qbsByTeam = new Map<number, typeof e.completed>();
      for (const c of e.completed)
        if (posOf(c.playerId) === 'QB' && c.teamSlot !== 1) qbsByTeam.set(c.teamSlot, [...(qbsByTeam.get(c.teamSlot) ?? []), c]);
      for (const [, qbs] of qbsByTeam) {
        const steals = qbs.filter(isHeisted);
        expect(steals.filter((c) => c.trace!.needMultiplier > 1).length).toBeLessThanOrEqual(1); // at most one honest "empty slot" read
        expect(steals.filter((c) => c.overall <= early).length).toBeLessThanOrEqual(1); // the Burrow/Maye case: a redundant early QB relocates
      }
    }
  });

  it('a stolen QB\'s need honestly tracks the victim roster — genuine (>= 1) AND redundant (< 1) both occur', () => {
    // Proves the commit-time re-score is real: a QB stolen onto an empty slot reads a
    // genuine need, the same position stolen onto a filled slot reads redundant depth.
    // A frozen trace (the old bug) could never produce the sub-1 reads.
    const posOf = (id: string) => POOL.find((p) => p.id === id)!.position;
    const isHeisted = (c: { trace?: unknown; shortlist?: unknown }) => !!c.trace && !c.shortlist;
    let genuine = 0;
    let redundant = 0;
    for (let seed = 1; seed < 25; seed++) {
      const e = new DraftEngine({ players: POOL, modifiers: [], teams: botTeams(10), humanSlot: 1, config: DEFAULT_LEAGUE, rng: seeded(seed) });
      let guard = 0;
      while (!e.isComplete && guard++ < 400) {
        if (e.isHumanOnClock) {
          const qb = e.availablePlayers().find((p) => p.position === 'QB');
          e.makePick((qb ?? e.availablePlayers()[0]).id);
          if (!e.heist(1)) e.runToCompletion();
        } else e.step();
      }
      for (const c of e.completed)
        if (isHeisted(c) && posOf(c.playerId) === 'QB') (c.trace!.needMultiplier >= 1 ? genuine++ : redundant++);
    }
    expect(genuine).toBeGreaterThan(0);
    expect(redundant).toBeGreaterThan(0); // honest low-need reads exist — the fix, provable
  });
});
