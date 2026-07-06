import type { LeagueConfig, Modifier } from '../types';

export const DEFAULT_LEAGUE: LeagueConfig = {
  teamCount: 10,
  roundCount: 15,
  preset: 'snake',
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 },
  // keeperCount omitted → no limit by default; set it to cap keepers per team.
};

// Library of one-click modifier rules. Each is a single "If [Tag] then [Action]".
export const MODIFIER_LIBRARY: Record<string, Omit<Modifier, 'id'>> = {
  tePremium: { matchTag: 'TE', action: 'score_mult', params: { factor: 1.5 }, priority: 0, enabled: true },
  superflex: { matchTag: 'QB', action: 'roster_max', params: { limit: 2 }, priority: 0, enabled: true },
  devyRookieBoost: { matchTag: 'Rookie', action: 'adp_boost', params: { pct: 0.2 }, priority: 0, enabled: true },
};

let counter = 0;
export function makeModifier(key: keyof typeof MODIFIER_LIBRARY): Modifier {
  return { id: `mod-${++counter}`, ...MODIFIER_LIBRARY[key] };
}
