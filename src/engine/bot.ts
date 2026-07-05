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
import { optimizeLineup, marginalStartingValue } from './roster';
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
  /** This team's current roster (completed picks + reserved keepers). */
  rosterPlayers: EffectivePlayer[];
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

/** Tally a roster by position (for roster_max caps and the backup penalty). */
function countByPosition(players: { position: Position }[]): Partial<Record<Position, number>> {
  const counts: Partial<Record<Position, number>> = {};
  for (const p of players) counts[p.position] = (counts[p.position] ?? 0) + 1;
  return counts;
}

/** View an effective player through the lineup optimizer's projected-points lens. */
const asStarter = (p: EffectivePlayer): Player => ({ ...p, projPoints: p.effProjPoints });

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
  const env = pickEnv(brain, ctx);
  const scored: ScoredCandidate[] = [];
  for (const player of ctx.available) {
    // Hard filter: roster_max caps (Superflex QB<=2, etc.).
    if (violatesRosterMax(player, env.positionCounts, env.caps)) continue;
    scored.push(scoreOne(player, env));
  }
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

/** Everything derivable ONCE per pick — computed here, reused for every candidate. */
interface PickEnv {
  w: { adp: number; chaos: number; need: number; age: number };
  baselines: ReturnType<typeof computeBaselines>;
  caps: ReturnType<typeof rosterMaxByMatch>;
  positionCounts: Partial<Record<Position, number>>;
  config: LeagueConfig;
  totalPlayerPool: number;
  rosterStarters: Player[];
  slots: LeagueConfig['rosterSlots'];
  baseStartingValue: number;
  pressure: number;
  redundancyBuffer: number;
  currentPick: number;
  isRound1Or2: boolean;
  draftFraction: number;
  rng: Rng;
}

function pickEnv(brain: Brain, ctx: SelectContext): PickEnv {
  const slots = ctx.config.rosterSlots;
  const rosterStarters = ctx.rosterPlayers.map(asStarter);
  const baseLineup = optimizeLineup(rosterStarters, slots);
  // Current pick number, deduced from how much of the pool has been drafted.
  const currentPick = ctx.totalPlayerPool - ctx.available.length + 1;
  const teams = ctx.config.teamCount;
  return {
    w: { adp: brain.adpBias / 100, chaos: brain.chaos / 100, need: brain.rosterNeed / 100, age: brain.ageUpside / 100 },
    // Baselines recomputed once per pick against the current pool, not per candidate.
    baselines: computeBaselines(ctx.available, ctx.config),
    caps: rosterMaxByMatch(ctx.modifiers),
    positionCounts: countByPosition(ctx.rosterPlayers),
    config: ctx.config,
    totalPlayerPool: ctx.totalPlayerPool,
    rosterStarters,
    slots,
    baseStartingValue: baseLineup.startingPoints,
    // Completion pressure: fraction of remaining picks that MUST become starters,
    // so bots fill a legal lineup (K/DST) late instead of hoarding skill players.
    pressure: Math.min(1, baseLineup.unfilled.length / Math.max(ctx.picksLeft ?? 999, 1)),
    // Early draft (over half the pool left) tolerates more redundancy.
    redundancyBuffer: ctx.available.length > ctx.totalPlayerPool / 2 ? 0.125 : 0.25,
    currentPick,
    isRound1Or2: currentPick <= teams * 2,
    draftFraction: currentPick / (teams * ctx.config.roundCount),
    rng: ctx.rng ?? Math.random,
  };
}

/** Score one candidate against the per-pick environment. Fully explainable. */
function scoreOne(player: EffectivePlayer, env: PickEnv): ScoredCandidate {
  const { w } = env;

  // 1. Base value: a steep 4th-degree ADP power curve so a need multiplier can't
  // cause massive reaches on deep players.
  const vbd = vbdOf(player, env.baselines);
  const adpValue = Math.pow(Math.max(0, 1 - player.effAdp / env.totalPlayerPool), 4) * 100;
  const baseValue = (1 - w.adp) * vbd + w.adp * adpValue;

  // 2. Roster-need (quality-aware): startImpact is the share of this player's
  // value that would reach our optimized STARTING lineup — 1 for a brand-new
  // starter or an upgrade over a weak keeper, 0 for pure bench depth. Need
  // rewards lineup impact (slider- and urgency-scaled) and fades redundancy.
  const msv = marginalStartingValue(env.rosterStarters, asStarter(player), env.slots, env.baseStartingValue);
  const startImpact = player.effProjPoints > 0 ? Math.min(1, msv / player.effProjPoints) : 0;
  const needMultiplier =
    1 + (w.need * 0.3 + env.pressure * 0.5) * startImpact - env.redundancyBuffer * (1 - startImpact);

  // 3. Age/upside tilt.
  const ageMultiplier = 1 + (player.tags.includes('Rookie') ? w.age * 0.3 : -w.age * 0.1);

  // 4. Chaos swing (capped early), 5. reach penalty (don't squander value on a
  // player likely to survive the turn), 6. early backup-QB/TE penalty.
  const chaosRoll = chaosMultiplier(env.rng, w.chaos * 0.4, env.isRound1Or2);
  const reachPenalty = reachPenaltyFor(player.effAdp, env.currentPick);
  const backupPenalty = earlyBackupPenalty(player, env.positionCounts, env.config, env.draftFraction);

  const finalScore =
    baseValue * needMultiplier * ageMultiplier * chaosRoll * reachPenalty * backupPenalty;

  return {
    player,
    finalScore,
    trace: {
      playerId: player.id,
      baseValue: round2(baseValue),
      adpBlendLabel: `${Math.round(w.adp * 100)}% ADP / ${Math.round((1 - w.adp) * 100)}% VBD`,
      needMultiplier: round2(needMultiplier),
      ageMultiplier: round2(ageMultiplier),
      chaosRoll: round2(chaosRoll),
      finalScore: round2(finalScore),
    },
  };
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
