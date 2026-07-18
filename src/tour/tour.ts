import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { type TourElementId, tourTarget } from './tour-types';
import { useDraftStore } from '../store/draftStore';
import { useCompare } from '../store/compare';
import { listSessions } from '../store/sessions';

// A step whose `element` must resolve to one of our typed anchor ids — a stray
// selector or a stale id is a compile error, not a broken tour at runtime.
interface SafeTourStep extends Omit<DriveStep, 'element'> {
  element: `[data-tour="${TourElementId}"]`;
}

const SLOT_A = 'Tour — Slot A';
const SLOT_B = 'Tour — Slot B';
const SLOT_A_SEAT = 3; // your seat for the first mock (leaves seats 1–2 free to swap)
const slotBSeat = () => useDraftStore.getState().config.teamCount; // the opposite end

let activeDriver: Driver | null = null;
let unsubscribePick: (() => void) | null = null;
let unsubscribeMove: (() => void) | null = null;

const clickAnchor = (id: TourElementId) =>
  (document.querySelector(`[data-tour="${id}"]`) as HTMLElement | null)?.click();

// Reveal the player card so the keeper controls (T#/R#/%/🔒) exist to point at.
const openCard = () => {
  if (!document.querySelector('.inspector')) clickAnchor('player-edit');
};

// Lock in a real keeper by pressing the actual 🔒 Keep button (top player, Team 1,
// 100%) — so the board visibly shows one, and each mock re-rolls it by its odds.
const setDemoKeeper = () => clickAnchor('keeper-save');

const humanPicks = (seat: number) =>
  useDraftStore.getState().engine?.teamPlayerIds(seat).length ?? 0;

// Auto-draft the whole board *including* the human seat. runToCompletion stops at
// the human's pick, so loop: pick the top available for the human, let bots run to
// the next human pick — this fills a real "your team" for Mock Stats.
const autoDraftAll = () => {
  const s = useDraftStore.getState();
  for (let guard = 0; guard < 1000; guard++) {
    const e = useDraftStore.getState().engine;
    if (!e || e.isComplete) break;
    if (e.isHumanOnClock) {
      const pool = e.availablePlayers();
      if (!pool.length) break;
      s.makePick(pool[0].id);
    } else {
      s.autoToHuman();
    }
  }
};

// Move to the next step after React has committed — a step whose anchor only
// appears once the app re-renders (the pre-draft board's seat arrows) isn't in the
// DOM synchronously, so defer past the current flush.
const advance = () => window.setTimeout(() => activeDriver?.moveNext(), 0);

// The team slot the demo keeper currently sits on (it starts on Team 1, then the
// user slides it). null once no keeper is set.
const keeperTeamSlot = (): number | null => {
  for (const c of useDraftStore.getState().cells.values()) {
    if (c.keepers?.length) return c.teamSlot;
  }
  return null;
};

// After the user's one real pick: finish this mock, save it as Slot A, and reset
// to the pre-draft board (silent — the save cleared `dirty`) so the seat arrows
// reappear for the user to move the keeper.
const finishDraftA = () => {
  const s = useDraftStore.getState();
  autoDraftAll();
  s.saveSession(SLOT_A);
  s.reset();
};

// After the user slides the keeper: run a second full mock from the opposite seat
// and save it as Slot B — the "run a batch from A, then from B" story.
const finishDraftB = () => {
  const s = useDraftStore.getState();
  s.setHumanSlot(slotBSeat());
  s.start();
  autoDraftAll();
  useDraftStore.getState().saveSession(SLOT_B);
};

// Start the first mock, run bots to the user's first pick, then wait: when their
// roster grows (they drafted) finish + save Slot A and advance to the keeper move.
const beginDraftPhase = () => {
  const s = useDraftStore.getState();
  if (s.engine?.isComplete) return;
  s.setHumanSlot(SLOT_A_SEAT);
  s.start();
  s.autoToHuman();
  const baseline = humanPicks(SLOT_A_SEAT);
  unsubscribePick?.();
  unsubscribePick = useDraftStore.subscribe(() => {
    if (humanPicks(SLOT_A_SEAT) <= baseline) return;
    unsubscribePick?.();
    unsubscribePick = null;
    finishDraftA();
    advance();
  });
};

// Wait for the user to nudge the keeper's team with a ◀▶ arrow: when its slot
// changes, run + save the second mock and advance to the comparison.
const armKeeperMove = () => {
  const baseline = keeperTeamSlot();
  unsubscribeMove?.();
  unsubscribeMove = useDraftStore.subscribe(() => {
    if (keeperTeamSlot() === baseline) return;
    unsubscribeMove?.();
    unsubscribeMove = null;
    finishDraftB();
    advance();
  });
};

// Check both saved mocks so the Mock Stats rail has 2+ to compare.
const checkBothSlots = () => {
  const { ids, toggle } = useCompare.getState();
  for (const r of listSessions()) {
    if ((r.name === SLOT_A || r.name === SLOT_B) && !ids.includes(r.id)) toggle(r.id);
  }
};

// Actions run on entering a step, so clicking Next drives the app to the state
// each step describes — the walkthrough performs the flow, not just narrates it.
const onEnter: Partial<Record<TourElementId, () => void>> = {
  'player-edit': openCard,
  'keeper-team': openCard,
  // Locking the keeper is the *result* of pressing Next on "Keeper 6/6", so it
  // runs on entering the next step — the board shows it only after you advance.
  'human-slot': () => {
    setDemoKeeper();
    useDraftStore.getState().setHumanSlot(SLOT_A_SEAT);
  },
  'draft-pick': beginDraftPhase,
  'seat-swap': armKeeperMove,
  'compare-slots': checkBothSlots,
  'mock-stats': checkBothSlots,
};

const steps: SafeTourStep[] = [
  {
    element: tourTarget('welcome'),
    popover: { title: '👋 Rock Ur Mock', description: 'A guided walkthrough of two offseason questions: which keepers rivals hold, and which draft slot suits you. You make just two moves — one pick and one keeper nudge — and the app drives the rest. Reset and delete the "Tour —" drafts afterward to undo it.' },
  },
  {
    element: tourTarget('player-search'),
    popover: { title: 'Keeper 1/6 — find the player', description: 'Type the name of a player a rival might keep to find him in the pool below.' },
  },
  {
    element: tourTarget('player-edit'),
    popover: { title: 'Keeper 2/6 — open his card', description: 'Click Edit on his row to open the player card (Next opens the top player here so you can see the keeper controls).' },
  },
  {
    element: tourTarget('keeper-team'),
    popover: { title: 'Keeper 3/6 — which team', description: 'In the Keeper row, pick which team keeps him (T1, T2, …).' },
  },
  {
    element: tourTarget('keeper-round'),
    popover: { title: 'Keeper 4/6 — which round', description: 'Pick the round the keeper costs that team (R1, R2, …).' },
  },
  {
    element: tourTarget('keeper-pct'),
    popover: { title: 'Keeper 5/6 — the odds', description: 'Set the % chance he\'s actually kept — 60 means kept in ~60% of mocks. For "keep A or B", assign a second player the same T# and R#; each mock keeps only one.' },
  },
  {
    element: tourTarget('keeper-save'),
    popover: { title: 'Keeper 6/6 — lock it in', description: 'Click 🔒 Keep to save the keeper. Press Next and watch the 🔒 badge appear on the board (Team 1, 50%). Each mock re-rolls it by the odds; repeat for every uncertain keeper.' },
  },
  {
    element: tourTarget('human-slot'),
    popover: { title: 'Slot 1/6 — pick your seat', description: 'Now the slot question. Set "Your seat" to the slot you want to test — Next puts you in Team 3 (slot A) for the first mock. You can also nudge any seat with the ◀ ▶ arrows on the board.' },
  },
  {
    element: tourTarget('start-draft'),
    popover: { title: 'Slot 2/6 — start', description: 'Start Draft begins the mock. Next clicks it and runs the bots up to your first pick.' },
  },
  {
    element: tourTarget('draft-pick'),
    popover: { title: 'Slot 3/6 — your pick', description: 'You\'re on the clock — draft any player below (hit its Draft button). That\'s the only pick you make: we simulate the rest of your picks and save it as your "Slot A" board, then hand it back to you to move the keeper.', showButtons: ['close'] },
  },
  {
    element: tourTarget('seat-swap'),
    popover: { title: 'Slot 4/6 — move the keeper', description: 'Your Slot-A board is saved. Now click ▶ above Team 1 to slide that team — its keeper rides along — to the next seat, giving the second mock a different board. (◀ ▶ swaps any two neighboring seats.) We then run and save a mock from the opposite slot.', showButtons: ['close'] },
  },
  {
    element: tourTarget('save-mock'),
    popover: { title: 'Slot 5/6 — saved', description: 'Each mock is named and saved here. We saved your first board as "Tour — Slot A" and the second (opposite seat, keeper moved) as "Tour — Slot B".' },
  },
  {
    element: tourTarget('compare-slots'),
    popover: { title: 'Slot 6/6 — check them', description: 'Tick 2+ saved drafts to compare. Next checked your two "Tour —" mocks here.' },
  },
  {
    element: tourTarget('mock-stats'),
    popover: { title: 'Read the winner', description: 'Mock Stats compares them: your starter floor/ceiling, best/worst boards, and how often each player falls to you. The slot with the better numbers is where you draft.' },
  },
];

export const launchTour = () => {
  activeDriver = driver({
    showProgress: true,
    // No Previous — the tour drives real app state forward (drafts, saves), so
    // stepping backward can't cleanly undo it. Next + close only.
    showButtons: ['next', 'close'],
    // Each step: (1) strip stray `.driver-active-element` classes — driver.js clears
    // the previous one from a node reference it commits asynchronously, so a React
    // re-render mid-transition leaves stale controls lit; (2) run the step's action
    // so advancing actually drives the app forward.
    onHighlightStarted: (_el, step) => {
      document
        .querySelectorAll('.driver-active-element')
        .forEach((el) => el.classList.remove('driver-active-element'));
      const id = (step.element as string).match(/data-tour="([^"]+)"/)?.[1] as TourElementId;
      onEnter[id]?.();
    },
    onDestroyed: () => {
      unsubscribePick?.();
      unsubscribeMove?.();
      unsubscribePick = null;
      unsubscribeMove = null;
    },
    steps,
  });
  activeDriver.drive();
};
