// Small shared primitives. Each replaces a pattern that was copy-pasted across
// several modules — one definition instead of many inline re-implementations.

import type { Player } from '../types';

/** Compact secondary line for a player: team · Bye N · R(ookie). One place to
 *  render (and extend) a player's at-a-glance attributes. */
export function playerMeta(p: Player): string {
  return [p.team, p.bye ? `Bye ${p.bye}` : '', p.tags.includes('Rookie') ? 'R' : '']
    .filter(Boolean)
    .join(' · ');
}

/** The universal player filter: every lowercase token must match the player's
 *  name, position, team, bye ("bye9"), or a tag. One predicate replaces the
 *  separate search box + position-filter + team + bye + tag controls. */
export function matchesQuery(p: Player, tokens: string[]): boolean {
  return tokens.every(
    (t) =>
      p.name.toLowerCase().includes(t) ||
      p.position.toLowerCase() === t ||
      p.team.toLowerCase().includes(t) ||
      (p.bye != null && `bye${p.bye}`.includes(t)) ||
      p.tags.some((g) => g.toLowerCase().includes(t)),
  );
}

/** Index any id-bearing items into a Map for O(1) lookup by id. */
export function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(it.id, it);
  return m;
}

/** The 1-based sequence [1..n] — team seats, board columns, round numbers. */
export function range1(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** Seeded PRNG (mulberry32): a deterministic 0-1 stream from an integer seed, so
 *  a draft replays identically. One generator, shared by the live store and the
 *  engine tests instead of re-implemented in each. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
