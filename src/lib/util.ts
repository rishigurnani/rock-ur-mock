// Small shared primitives. Each replaces a pattern that was copy-pasted across
// several modules — one definition instead of many inline re-implementations.

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
