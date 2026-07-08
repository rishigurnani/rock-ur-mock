import { useDraftStore } from './store/draftStore';
import { SetupPanel } from './components/SetupPanel';
import { PickMatrix } from './components/PickMatrix';
import { DraftRoom } from './components/DraftRoom';
import { MockStats } from './components/MockStats';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const store = useDraftStore();
  const { engine, started } = store;
  const complete = engine?.isComplete ?? false;
  const humanOnClock = engine?.isHumanOnClock ?? false;

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>🏈 Rock Ur Mock</h1>
          <div className="sub">Elegant, algorithm-driven mock draft simulator</div>
        </div>
        <div className="controls">
          {!started ? (
            <button className="primary" onClick={store.start}>
              Start Draft
            </button>
          ) : (
            <>
              <button onClick={store.step} disabled={complete || humanOnClock}>
                Step
              </button>
              <button onClick={store.autoToHuman} disabled={complete || humanOnClock}>
                Auto-run ▶▶
              </button>
              <button onClick={store.reset}>Reset</button>
              {complete && <span className="badge">Complete</span>}
            </>
          )}
        </div>
      </div>

      <div className="grid-2">
        <SetupPanel />
        <ErrorBoundary>
          <div>
            <PickMatrix />
            <DraftRoom />
          </div>
        </ErrorBoundary>
      </div>
      <ErrorBoundary><MockStats /></ErrorBoundary>
    </div>
  );
}
