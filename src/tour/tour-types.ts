// Single source of truth for every element allowed to host a guided-tour step.
// Adding a step means adding an id here first; the config and the JSX anchors are
// both type-checked against this union, so a rename or typo fails `npm run typecheck`.
export type TourElementId =
  | 'welcome'
  | 'player-search'
  | 'player-edit'
  | 'keeper-team'
  | 'keeper-round'
  | 'keeper-pct'
  | 'keeper-save'
  | 'human-slot'
  | 'start-draft'
  | 'draft-pick'
  | 'seat-swap'
  | 'save-mock'
  | 'compare-slots'
  | 'mock-stats';

// Spread onto a JSX element to tag it as a tour anchor: {...tourAnchor('welcome')}.
// The argument is typed, so an unmapped id will not compile — no silent drift.
export const tourAnchor = (id: TourElementId) => ({ 'data-tour': id });

// The CSS selector a DriveStep targets, constrained to a real anchor id.
export const tourTarget = (id: TourElementId) => `[data-tour="${id}"]` as const;
