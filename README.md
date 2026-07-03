# Rock Ur Mock

A fantasy football mock draft simulator. No AI — every bot decision is driven by four configurable sliders and is fully transparent.

## Quick start

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # Run tests
npm run build     # typecheck + production build
```

## What it does

You set up a draft (number of teams, rounds, roster slots, scoring format), configure bot personalities, and run through a snake draft. You can pick for your own team or watch a full bot sim. Each bot pick shows a score breakdown so you can see exactly why a player was chosen.

Features:
- Snake/linear draft order, traded picks, and keeper slots (configured per cell in the Pick Matrix)
- Scoring format modifiers: TE-premium, Superflex, IDP, etc. — each is an `If [tag] → action` rule you can add or remove
- Bot personalities controlled by four sliders: ADP bias, chaos, roster need, age upside
- Injury what-if overrides: zero out a player's projected points to simulate them being out
- God-Mode traces: hover any pick on the board to see the full math behind the bot's decision
- Swap ranking sources or upload a custom CSV

## Where saved drafts are stored

Drafts are saved to your **browser's localStorage** under the key `rockurmock.sessions`. They persist across page refreshes as long as you're using the same browser on the same machine. Clearing your browser's site data will delete them.

There is no server or database backend yet — the `db/schema.sql` file defines the intended PostgreSQL schema for a future backend, but it is not wired up. Everything runs client-side.

## How the engine works

```
base   = (1 - adpBias) × VBD  +  adpBias × adpValue
score  = base
       × needMultiplier    (+50% for a needed starter, −15% for a redundant position)
       × ageMultiplier     (+30% rookie … −10% veteran, scaled by ageUpside slider)
       × chaosRoll         (1 ± chaos × 0.40, bounded)
```

VBD (value over baseline) is recomputed against the current available player pool on every pick, not at draft start. `roster_max` modifier rules (e.g. Superflex QB ≤ 2) are hard filters applied before scoring.

## Code layout

| Area | Files |
|------|-------|
| Draft orchestration | `src/engine/draft.ts` |
| Pick Matrix (order, keepers, timers) | `src/engine/matrix.ts` |
| Modifier rules engine | `src/engine/modifiers.ts` |
| Bot scoring | `src/engine/bot.ts`, `src/engine/vbd.ts`, `src/engine/roster.ts` |
| Player data / CSV parsing | `src/data/datasets.ts`, `src/data/parseRankings.ts` |
| State (Zustand store + session save/restore) | `src/store/draftStore.ts` |

The engine (`src/engine/*`) has no React imports and routes all randomness through an injectable RNG, so drafts are reproducible with a fixed seed and straightforward to unit test.

## Status

- Engine is complete with 15 passing tests
- Draft room UI is working end-to-end
- Not yet implemented: CSV upload UI, auction sub-engine, backend wiring to the DB schema
