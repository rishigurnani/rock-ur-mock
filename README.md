# Rock Ur Mock

**A faster way to run a fantasy football mock draft.**

Rock Ur Mock is a browser-based mock draft simulator. Set up a league, tune your
bot opponents, and draft — with no AI and no black boxes. Every pick a bot makes
comes with a full breakdown of the math behind it.

![Rock Ur Mock](docs/rock-ur-mock.png)

## What is Rock Ur Mock?

Rock Ur Mock lets you rehearse your fantasy draft against opponents you control.
You configure the league (teams, rounds, roster, scoring), give each bot a
personality, and either draft your own team or watch a full simulation play out.
Because there's no LLM involved, drafts are deterministic and reproducible — the
same seed always produces the same draft.

## Why choose Rock Ur Mock?

- **Fully transparent.** Hover any pick on the board to see the exact score
  breakdown (value, ADP, roster need, age, and the chaos roll) that produced it.
- **Bots you actually control.** Each bot is four sliders — ADP bias, chaos,
  roster need, and age upside — so you can build a value-hunter, a reacher, or a
  wildcard.
- **Any format.** Snake or linear order, traded picks, keepers, TE-premium,
  Superflex, IDP — all expressed as simple `If [tag] → action` rules you add or
  remove.
- **Runs entirely in your browser.** No account, no server, no setup beyond
  `npm install`.

## Installation

```bash
npm install
npm run dev       # http://localhost:5173
```

Then open http://localhost:5173 in your browser and you're ready to draft.

## Quickstart

1. **Set up the league** — pick the number of teams, rounds, roster slots, and
   scoring format.
2. **Tune the bots** — drag the four sliders on each team to shape how they draft.
3. **Draft** — take your own team's picks, or hit run and watch the whole thing
   simulate. Hover any completed pick to see why the bot chose that player.

Want an injury what-if? Zero out a player's projected points and re-run to see
how the board shifts.

## Give me more!

| Feature | What it does |
|---------|--------------|
| **Pick Matrix** | Snake/linear order, traded picks, keepers, and per-pick timers |
| **Slider bots** | Four sliders per bot define every draft personality |
| **God-Mode traces** | The full scoring math behind every bot pick, on hover |
| **What-if injuries** | Zero a player's projection to simulate them being out |
| **Custom rankings** | Swap ranking sources or upload your own CSV |

## Where your drafts are saved

Saved drafts live in your **browser's localStorage** under the key
`rockurmock.sessions`. They stick around across page refreshes as long as you
use the same browser on the same machine. Clearing your browser's site data
removes them.

There's no server or database yet: `db/schema.sql` sketches the PostgreSQL schema
for a future backend, but nothing is wired up to it. Everything runs client-side.

## Resources

- **Code layout**

  | Area | Files |
  |------|-------|
  | Draft orchestration | `src/engine/draft.ts` |
  | Pick Matrix | `src/engine/matrix.ts` |
  | Modifier rules | `src/engine/modifiers.ts` |
  | Bot scoring | `src/engine/bot.ts`, `src/engine/vbd.ts`, `src/engine/roster.ts` |
  | Player data / CSV parsing | `src/data/datasets.ts`, `src/data/parseRankings.ts` |
  | State + session save/restore | `src/store/draftStore.ts` |

- **Testing** — `npm test` runs the engine test suite. `npm run build`
  typechecks and produces a production build.
- **Engine design** — `src/engine/*` has no React imports and routes all
  randomness through an injectable RNG, so drafts are reproducible and easy to
  unit test.
