# 🏈 Rock Ur Mock

An elegant, **algorithm-driven** fantasy mock draft simulator. No LLMs — every
decision is transparent, deterministic, and fast. Four generalized primitives
replace dozens of niche hard-coded features.

## Quick start

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # engine test suite (15 tests)
npm run build     # typecheck + production build
```

## The four primitives → where they live

| Primitive | What it generalizes | Code |
| --- | --- | --- |
| **Pick Matrix** | Snake / Linear / traded picks / keepers / per-cell timers | [`src/engine/matrix.ts`](src/engine/matrix.ts) |
| **Universal Modifier Engine** | TE-Premium, Superflex, Devy/Dynasty, IDP… as `If [Tag] then [Action]` | [`src/engine/modifiers.ts`](src/engine/modifiers.ts) |
| **Algorithmic Slider Bots** | Every AI personality = 4 sliders (ADP bias / chaos / need / age) | [`src/engine/bot.ts`](src/engine/bot.ts) |
| **Base Data Swapper** | Ranking sources, custom CSVs, injury what-ifs | [`src/data/datasets.ts`](src/data/datasets.ts) + [`parseRankings.ts`](src/data/parseRankings.ts) |

Supporting engine modules: [`vbd.ts`](src/engine/vbd.ts) (value-based drafting
baselines), [`roster.ts`](src/engine/roster.ts) (starting-slot needs),
[`draft.ts`](src/engine/draft.ts) (the pick-by-pick orchestrator).

## Architecture

- **Engine is pure & framework-free.** `src/engine/*` has no React imports and
  routes all randomness through an injectable RNG, so drafts are reproducible
  (seeded) and unit-testable. The UI is a thin renderer over it.
- **State: Zustand** ([`src/store/draftStore.ts`](src/store/draftStore.ts)).
  The imperative `DraftEngine` instance lives in the store; a `version` counter
  signals React to re-read snapshots after each mutation.
- **God-Mode traces** — every bot pick returns a `ScoreTrace` (base value, ADP
  blend, need/age multipliers, chaos roll, final score). Hover any drafted cell
  in the Pick Matrix to see the math.
- **Base Data Swapper** — a dataset *registry* ([`src/data/datasets.ts`](src/data/datasets.ts))
  where each ranking source yields `Player[]` on demand. The default loads the
  FantasyPros 2026 CSV through a generic, header-aliased parser
  ([`parseRankings.ts`](src/data/parseRankings.ts)) that maps any similarly-shaped
  export and synthesizes projections from positional rank. **Adding a future
  ranking = one line in the registry**, or a live CSV upload from the UI.
- **Persistence:** [`db/schema.sql`](db/schema.sql). The DB persists setup and
  results; the live engine is the source of truth mid-draft. Sparse
  `matrix_cells` + rule-row `modifiers` keep it bloat-free.

## Bot Draft Score

```
base   = (1-adpBias)·VBD + adpBias·adpValue
score  = base
       × needMultiplier   (+50% needed starter … −15% redundant)
       × ageMultiplier    (+30% rookie … −10% veteran, scaled by ageUpside)
       × chaosRoll         (1 ± chaos·0.40, bounded)
```

VBD baselines are recomputed once per pick (not per candidate) against the
current pool. `roster_max` modifiers (e.g. Superflex QB ≤ 2) are hard filters.

## Status

- ✅ Pure engine + 15 passing tests (matrix, modifiers, full-draft sim, keepers,
  Superflex caps, human-seat pausing, seed reproducibility)
- ✅ Working draft room: setup, modifiers, per-bot brains, snake board, human
  picking, what-if injury overrides, keepers, God-Mode traces
- ⏭️ Next: modular snap-to-grid widget dashboard, auction sub-engine, CSV
  upload UI, backend wiring to `db/schema.sql`
