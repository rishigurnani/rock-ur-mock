// ============================================================================
// Algorithmic Slider Bot
// ----------------------------------------------------------------------------
// Every bot is four 0-100 sliders. Each slider maps to exactly one term in the
// Draft Score, and every intermediate value is returned as a ScoreTrace so the
// tooltip is free and the pick is fully explainable.
// ============================================================================

import type { Brain, LeagueConfig, Modifier, Player, Position, ScoreTrace } from '../types';
import { rosterMaxByMatch, violatesRosterMax, type EffectivePlayer } from './modifiers';
import { computeBaselines, vbdOf } from './vbd';
import { optimizeLineup, marginalStartingValue } from './roster';

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
  /**
   * The true overall pick number now on the clock (1-based). Must come from the
   * engine — it can't be inferred from pool depletion, because reserved keepers
   * are pulled out of the pool up front and would inflate the estimate.
   */
  currentPick: number;
  /** Picks this team has left (incl. the current one). Drives fill urgency. */
  picksLeft?: number;
  /** Picks until this team is on the clock again — the VONA scarcity horizon. */
  picksUntilNext?: number;
  rng?: Rng;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Tally a roster by position (for roster_max caps and the backup penalty). */
function countByPosition(players: { position: Position }[]): Partial<Record<Position, number>> { const counts: Partial<Record<Position, number>> = {}; for (const p of players) counts[p.position] = (counts[p.position] ?? 0) + 1; return counts; }

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
function earlyBackupPenalty(player: EffectivePlayer, positionCounts: Partial<Record<Position, number>>, config: LeagueConfig, draftFraction: number): number {
  if (player.position !== 'QB' && player.position !== 'TE') return 1.0;
  const req = config.rosterSlots[player.position] ?? 0; const have = positionCounts[player.position] ?? 0;
  return req > 0 && have >= req && draftFraction < 0.67 ? 0.5 : 1.0;
}

/**
 * Score every legal candidate and return them sorted best-first.
 * Exposed (rather than only the winner) so the UI can show the shortlist.
 */
export function scoreCandidates(brain: Brain, ctx: SelectContext): ScoredCandidate[] {
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

const FLEX_ELIGIBLE = new Set<Position>(['RB', 'WR', 'TE']);
const ALL_POS: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/** Per-position roster-need signal ∈ [0, ~2]: how short you are of starter-caliber
 *  bodies there — an incumbent below the replacement baseline counts as a hole
 *  (Signal A) — PLUS how steeply the position cliffs before your next pick, i.e.
 *  VONA (Signal B). Higher = address this position now. */
export function positionalNeed(
  ctx: SelectContext,
  baselines: Record<Position, number>,
): Record<Position, number> {
  const slots = ctx.config.rosterSlots;
  const flexShare = (slots.FLEX ?? 0) / FLEX_ELIGIBLE.size;
  const horizon = ctx.picksUntilNext ?? ctx.config.teamCount;
  const availByPos = new Map<Position, number[]>();
  for (const p of ctx.available) availByPos.set(p.position, [...(availByPos.get(p.position) ?? []), p.effProjPoints]);

  const out = {} as Record<Position, number>;
  for (const pos of ALL_POS) {
    const demand = (slots[pos] ?? 0) + (FLEX_ELIGIBLE.has(pos) ? flexShare : 0);
    const held = ctx.rosterPlayers.filter((p) => p.position === pos && p.effProjPoints >= baselines[pos]).length;
    const gap = demand > 0 ? Math.max(0, demand - held) / demand : 0; // Signal A
    const avail = (availByPos.get(pos) ?? []).sort((a, b) => b - a);
    const best = avail[0] ?? 0;
    const next = avail[Math.min(horizon, avail.length - 1)] ?? 0;
    const scarcity = best > 0 ? Math.max(0, best - next) / best : 0; // Signal B (VONA)
    out[pos] = gap + scarcity;
  }
  return out;
}

/** Everything derivable ONCE per pick — computed here, reused for every candidate. */
interface PickEnv { w: { adp: number; chaos: number; need: number; age: number; }; baselines: ReturnType<typeof computeBaselines>; caps: ReturnType<typeof rosterMaxByMatch>; positionCounts: Partial<Record<Position, number>>; config: LeagueConfig; totalPlayerPool: number; rosterStarters: Player[]; slots: LeagueConfig['rosterSlots']; baseStartingValue: number; pressure: number; redundancyBuffer: number; positionalNeed: Record<Position, number>; currentPick: number; isRound1Or2: boolean; draftFraction: number; rng: Rng; }

function pickEnv(brain: Brain, ctx: SelectContext): PickEnv {
  const slots = ctx.config.rosterSlots;
  const rosterStarters = ctx.rosterPlayers.map(asStarter);
  const baseLineup = optimizeLineup(rosterStarters, slots);
  // The true overall pick, supplied by the engine (NOT inferred from pool size,
  // which reserved keepers would inflate — breaking the round-1/2 chaos cap).
  const currentPick = ctx.currentPick;
  const teams = ctx.config.teamCount;
  // A team's final two DRAFTABLE picks (picksLeft already excludes keeper slots)
  // lean 10x harder on roster need — the last real chances to patch a lineup hole.
  const needBoost = (ctx.picksLeft ?? Infinity) <= 2 ? 10 : 1;
  // Baselines recomputed once per pick against the current pool, not per candidate.
  const baselines = computeBaselines(ctx.available, ctx.config);
  return {
    w: { adp: brain.adpBias / 100, chaos: brain.chaos / 100, need: (brain.rosterNeed / 100) * needBoost, age: brain.ageUpside / 100 },
    baselines, positionalNeed: positionalNeed(ctx, baselines), caps: rosterMaxByMatch(ctx.modifiers),
    positionCounts: countByPosition(ctx.rosterPlayers), config: ctx.config,
    totalPlayerPool: ctx.totalPlayerPool, rosterStarters, slots,
    baseStartingValue: baseLineup.startingPoints,
    // Completion pressure: fraction of remaining picks that MUST become starters,
    // so bots fill a legal lineup (K/DST) late instead of hoarding skill players.
    pressure: Math.min(1, baseLineup.unfilled.length / Math.max(ctx.picksLeft ?? 999, 1)),
    // Early draft (over half the pool left) tolerates more redundancy.
    redundancyBuffer: ctx.available.length > ctx.totalPlayerPool / 2 ? 0.125 : 0.25,
    currentPick, isRound1Or2: currentPick <= teams * 2,
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
  // value that reaches our optimized STARTING lineup — 1 for a brand-new starter,
  // a fraction for an upgrade over an existing starter, 0 for pure bench depth.
  // The redundancy penalty is for DEPTH only: anyone who cracks the lineup
  // (startImpact > 0) is a starter and is exempt, even on a partial upgrade.
  // (Rosters here are post keeper-roll: kept keepers count fully, released ones not.)
  const msv = marginalStartingValue(env.rosterStarters, asStarter(player), env.slots, env.baseStartingValue);
  const startImpact = player.effProjPoints > 0 ? Math.min(1, msv / player.effProjPoints) : 0;
  const redundancy = startImpact > 0 ? 0 : env.redundancyBuffer;
  // Positional urgency (slider-scaled): a below-baseline hole at, or a scarcity
  // cliff before your next pick for, this player's position — but only a
  // starter-caliber body (vbd > 0) actually answers that need.
  const posNeed = vbd > 0 ? env.positionalNeed[player.position] : 0;
  const needMultiplier = 1 + (w.need * 0.3 + env.pressure * 0.5) * startImpact + w.need * 0.15 * posNeed - redundancy;

  // 3. Age/upside tilt.
  const ageMultiplier = 1 + (player.tags.includes('Rookie') ? w.age * 0.3 : -w.age * 0.1);

  // 4. Chaos swing (capped early), 5. reach penalty (don't squander value on a
  // player likely to survive the turn), 6. early backup-QB/TE penalty.
  const chaosRoll = chaosMultiplier(env.rng, w.chaos * 0.4, env.isRound1Or2);
  const reachPenalty = reachPenaltyFor(player.effAdp, env.currentPick);
  const backupPenalty = earlyBackupPenalty(player, env.positionCounts, env.config, env.draftFraction);

  const finalScore = baseValue * needMultiplier * ageMultiplier * chaosRoll * reachPenalty * backupPenalty;
  return {
    player, finalScore,
    trace: {
      playerId: player.id, baseValue: round2(baseValue),
      adpBlendLabel: `${Math.round(w.adp * 100)}% ADP / ${Math.round((1 - w.adp) * 100)}% VBD`,
      needMultiplier: round2(needMultiplier), ageMultiplier: round2(ageMultiplier),
      chaosRoll: round2(chaosRoll), finalScore: round2(finalScore),
    },
  };
}

export const PRESETS: Record<string, Brain> = {
  balanced:      { adpBias: 50, chaos: 20, rosterNeed: 40, ageUpside: 50 },
  // Sharp: even VBD/ADP blend, moderate variance, a light roster nudge, value-only (no age).
  sharp:         { adpBias: 50, chaos: 50, rosterNeed: 25, ageUpside:  0 },
  // Follows the crowd, low variance.
  sharkADP:      { adpBias: 90, chaos:  5, rosterNeed: 30, ageUpside: 40 },
  // Pure value hunter.
  vbdRobot:      { adpBias:  0, chaos:  0, rosterNeed: 20, ageUpside: 40 },
  // The Taco — maximum chaos.
  taco:          { adpBias: 30, chaos:100, rosterNeed: 20, ageUpside: 60 },
  // Fills needs relentlessly.
  needFirst:     { adpBias: 40, chaos: 10, rosterNeed:100, ageUpside: 40 },
  // Dynasty upside chaser.
  youthMovement: { adpBias: 35, chaos: 25, rosterNeed: 30, ageUpside:100 },
};

export type { Player };