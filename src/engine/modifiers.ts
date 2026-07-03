// ============================================================================
// Universal Modifier Engine
// ----------------------------------------------------------------------------
// One primitive — "If [Tag] then [Action]" — generalizes TE-Premium, Superflex,
// Devy/Dynasty ADP boosts, etc. Modifiers are applied deterministically in
// priority order to produce an "effective" view of each player for a draft.
// ============================================================================

import type { Modifier, Player, Position } from '../types';

/** A player with modifier-adjusted values. Baseline fields are preserved. */
export interface EffectivePlayer extends Player {
  /** projPoints after all score_mult modifiers. */
  effProjPoints: number;
  /** adp after all adp_boost modifiers (lower = earlier). */
  effAdp: number;
}

/** A modifier matches a player if its tag equals the position or is in tags. */
function matches(mod: Modifier, player: Player): boolean {
  if (!mod.enabled) return false;
  if (mod.matchTag === player.position) return true;
  return player.tags.includes(mod.matchTag);
}

/**
 * Produce the effective (modifier-adjusted) view of every player.
 * Pure: does not mutate the input players.
 */
export function applyModifiers(
  players: Player[],
  modifiers: Modifier[],
): EffectivePlayer[] {
  const ordered = [...modifiers].sort((a, b) => a.priority - b.priority);

  return players.map((p) => {
    let effProjPoints = p.projPoints;
    let effAdp = p.adp;

    for (const mod of ordered) {
      if (!matches(mod, p)) continue;
      switch (mod.action) {
        case 'score_mult':
          effProjPoints *= mod.params.factor ?? 1;
          break;
        case 'adp_boost':
          // Boost = drafted earlier = lower ADP number.
          effAdp *= 1 - (mod.params.pct ?? 0);
          break;
        case 'roster_max':
          // Roster limits don't alter player value; see rosterMaxByMatch.
          break;
      }
    }

    return { ...p, effProjPoints, effAdp };
  });
}

/**
 * Resolve roster_max modifiers into per-position (or per-tag) caps.
 * Returns a map of matchTag -> max count. e.g. Superflex => { QB: 2 }.
 * The most restrictive (lowest) limit wins when multiple modifiers collide.
 */
export function rosterMaxByMatch(modifiers: Modifier[]): Map<string, number> {
  const caps = new Map<string, number>();
  for (const mod of modifiers) {
    if (!mod.enabled || mod.action !== 'roster_max') continue;
    const limit = mod.params.limit;
    if (limit == null) continue;
    const existing = caps.get(mod.matchTag);
    caps.set(mod.matchTag, existing == null ? limit : Math.min(existing, limit));
  }
  return caps;
}

/**
 * True if adding `player` would violate any roster_max cap given the positions
 * already on the roster.
 */
export function violatesRosterMax(
  player: Player,
  currentCounts: Partial<Record<Position, number>>,
  caps: Map<string, number>,
): boolean {
  for (const [tag, limit] of caps) {
    const isMatch = tag === player.position || player.tags.includes(tag);
    if (!isMatch) continue;
    // Count how many the roster already has matching this tag.
    const have =
      tag in currentCounts
        ? currentCounts[tag as Position] ?? 0
        : sumMatching(currentCounts, tag, player);
    if (have + 1 > limit) return true;
  }
  return false;
}

function sumMatching(
  counts: Partial<Record<Position, number>>,
  tag: string,
  _sample: Player,
): number {
  // For position-tag caps the direct lookup above handles it; tag-based caps
  // over non-position tags aren't tracked per-count here (rare), so treat as 0.
  return counts[tag as Position] ?? 0;
}
