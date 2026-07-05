// ============================================================================
// Algorithmic Slider Bot
// ----------------------------------------------------------------------------
// Every bot is four 0-100 sliders. Each slider maps to exactly one term in the
// Draft Score, and every intermediate value is returned as a ScoreTrace so the
// God-Mode tooltip is free and the pick is fully explainable.
// ============================================================================

import type { Brain, LeagueConfig, Player, Position, ScoreTrace } from '../types';
import type { EffectivePlayer } from './modifiers';
import { computeBaselines, vbdOf } from './vbd';
import { fillsStartingSlot, unfilledStarterCount, RosterState } from './roster';
import { rosterMaxByMatch, violatesRosterMax } from './modifiers';
import type { Modifier } from '../types';

/** Injectable RNG so drafts are reproducible in tests. Defaults to Math.random. */
export type Rng = () => number;

export interface ScoredCandidate {
  player: EffectivePlayer;
  finalScore: number;
  trace: ScoreTrace;
}

export interface SelectContext {
  available: EffectivePlayer[];
  roster: RosterState;
  positionCounts: Partial<Record<Position, number>>;
  config: LeagueConfig;
  modifiers: Modifier[];
  totalPlayerPool: number;
  /** Picks this team has left (incl. the current one). Drives fill urgency. */
  picksLeft?: number;
  rng?: Rng;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Bounded ±weight uniform chaos swing; capped at ±10% early (rounds 1-2). */
function chaosMultiplier(rng: Rng, weight: number, capEarly: boolean): number {
  const eff = capEarly ? Math.min(weight, 0.1) : weight;
  return 1 + (rng() * 2 - 1) * eff;
}

/** Reach penalty: fade a player whose ADP sits well past the current pick. */
function reachPenaltyFor(effAdp: number, currentPick: number): number {
  const delta = effAdp - currentPick;
  return delta > 12 ? Math.max(0.4, 1 - (delta - 12) / 32) : 1.0;
}

/** Halve a backup QB/TE (beyond the starting requirement) in the first 67%. */
function earlyBackupPenalty(
  player: EffectivePlayer,
  positionCounts: Partial<Record<Position, number>>,
  config: LeagueConfig,
  draftFraction: number,
): number {
  if (player.position !== 'QB' && player.position !== 'TE') return 1.0;
  const req = config.rosterSlots[player.position] ?? 0;
  const have = positionCounts[player.position] ?? 0;
  return req > 0 && have >= req && draftFraction < 0.67 ? 0.5 : 1.0;
}

/**
 * Score every legal candidate and return them sorted best-first.
 * Exposed (rather than only the winner) so the UI can show the shortlist.
 */
export function scoreCandidates(
  brain: Brain,
  ctx: SelectContext,
): ScoredCandidate[] {
  const rng = ctx.rng ?? Math.random;
  const w = {
    adp: brain.adpBias / 100,
    chaos: brain.chaos / 100,
    need: brain.rosterNeed / 100,
    age: brain.ageUpside / 100,
  };

  // Baselines recomputed once per pick against the current pool — not per
  // candidate (that would be O(n^2)).
  const baselines = computeBaselines(ctx.available, ctx.config);
  const caps = rosterMaxByMatch(ctx.modifiers);

  // Roster-completion pressure: the fraction of this team's remaining picks
  // that MUST become starters. As it approaches 1, filling an open mandatory
  // slot (e.g. the neglected K/DST) outweighs raw value — so bots field a legal
  // lineup instead of hoarding skill players. Independent of the sliders.
  const unfilled = unfilledStarterCount(ctx.roster.counts, ctx.config.rosterSlots);
  const pressure = Math.min(1, unfilled / Math.max(ctx.picksLeft ?? 999, 1));

  // Derive draft progress using only the player pool size.
  // If more than half the player pool remains, we are in the early stages.
  const isEarlyDraft = ctx.available.length > (ctx.totalPlayerPool / 2);
  const redundancyBuffer = isEarlyDraft ? 0.125 : 0.25;

  // Mathematically deduce current pick number based on the depleted pool size.
  const currentPick = ctx.totalPlayerPool - ctx.available.length + 1;

  // Determine if we are currently in Round 1 or 2
  const teams = ctx.config.teamCount;
  const isRound1Or2 = currentPick <= (teams * 2);

  // Draft progress by pick count, 0..1. Used to deter early backup QB/TE picks.
  const totalPicks = teams * ctx.config.roundCount;
  const draftFraction = currentPick / totalPicks;

  const scored: ScoredCandidate[] = [];

  for (const player of ctx.available) {
    // Hard filter: roster_max caps (Superflex QB<=2, etc.).
    if (violatesRosterMax(player, ctx.positionCounts, caps)) continue;

    // 1. Base value: Changed from a linear slope to a steep 4th-degree power curve.
    // This exponentially drops the value of deeper players so a need multiplier can't cause massive reaches.
    const vbd = vbdOf(player, baselines);
    const adpFraction = 1 - player.effAdp / ctx.totalPlayerPool;
    const adpValue = Math.pow(Math.max(0, adpFraction), 4) * 100; 
    const baseValue = (1 - w.adp) * vbd + w.adp * adpValue;

    // 2. Roster-need: Apply the redundancy buffer if the player isn't an immediate starter.
    const needed = fillsStartingSlot(ctx.roster, player.position, ctx.config);
    const needMultiplier = needed
      ? 1 + w.need * 0.025 + pressure * 0.5
      : 1 - redundancyBuffer;

    // 3. Age/upside tilt.
    const isRookie = player.tags.includes('Rookie');
    const ageMultiplier = 1 + (isRookie ? w.age * 0.3 : -w.age * 0.1);

    // 4. Chaos swing (capped early in rounds 1-2), 5. reach penalty (don't
    // squander value on a player likely to survive the turn), and 6. the early
    // backup-QB/TE penalty. Each is a small pure function, kept out of the loop.
    const chaosRoll = chaosMultiplier(rng, w.chaos * 0.4, isRound1Or2);
    const reachPenalty = reachPenaltyFor(player.effAdp, currentPick);
    const backupPenalty = earlyBackupPenalty(player, ctx.positionCounts, ctx.config, draftFraction);

    const finalScore =
      baseValue * needMultiplier * ageMultiplier * chaosRoll * reachPenalty * backupPenalty;

    scored.push({
      player,
      finalScore,
      trace: {
        playerId: player.id,
        baseValue: round2(baseValue),
        adpBlendLabel: `${Math.round(w.adp * 100)}% ADP / ${Math.round(
          (1 - w.adp) * 100,
        )}% VBD`,
        needMultiplier: round2(needMultiplier),
        ageMultiplier: round2(ageMultiplier),
        chaosRoll: round2(chaosRoll),
        finalScore: round2(finalScore),
      },
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

/** Pick the single best candidate for a bot. Returns null if none are legal. */
export function selectPick(
  brain: Brain,
  ctx: SelectContext,
): ScoredCandidate | null {
  const scored = scoreCandidates(brain, ctx);
  return scored[0] ?? null;
}

export const PRESETS: Record<string, Brain> = {
  balanced: { adpBias: 50, chaos: 20, rosterNeed: 40, ageUpside: 50 },
  // Sharp: pure value (100% VBD), light variance, real roster discipline.
  sharp: { adpBias: 0, chaos: 10, rosterNeed: 50, ageUpside: 40 },
  // Follows the crowd, low variance.
  sharkADP: { adpBias: 90, chaos: 5, rosterNeed: 30, ageUpside: 40 },
  // Pure value hunter.
  vbdRobot: { adpBias: 0, chaos: 0, rosterNeed: 20, ageUpside: 40 },
  // The Taco — maximum chaos.
  taco: { adpBias: 30, chaos: 100, rosterNeed: 20, ageUpside: 60 },
  // Fills needs relentlessly.
  needFirst: { adpBias: 40, chaos: 10, rosterNeed: 100, ageUpside: 40 },
  // Dynasty upside chaser.
  youthMovement: { adpBias: 35, chaos: 25, rosterNeed: 30, ageUpside: 100 },
};

export type { Player };
