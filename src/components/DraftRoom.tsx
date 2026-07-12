import { useEffect, useMemo, useState } from 'react';
import { useDraftStore } from '../store/draftStore';
import { optimizeLineup, byeClashes, type LineupSeat } from '../engine/roster';
import { indexById, range1, playerMeta, matchesQuery } from '../lib/util';
import type { Player, Position } from '../types';

const POSITIONS: (Position | 'ALL')[] = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/** One optimized-lineup seat: its slot, the seated player (or an empty marker),
 *  bye, and projected points. Extracted so the lineup map stays a one-liner. */
function StarterRow({ seat: { player, slot } }: { seat: LineupSeat }) {
  return (
    <div className="player-row">
      <span className={`pos ${player?.position ?? ''}`}>{slot}</span>
      <span className="name">{player ? player.name : <em className="num">— empty —</em>}</span>
      <span className="num">{player?.bye ? `Bye ${player.bye}` : ''}</span>
      <span className="num">{player ? `${player.projPoints} pts` : ''}</span>
    </div>
  );
}

export function DraftRoom() {
  const store = useDraftStore();
  const { engine, players, started, config } = store;
  const [filter, setFilter] = useState<Position | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [rosterSlot, setRosterSlot] = useState(store.humanSlot ?? 1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Loading a different draft (or a fresh start) builds a new engine instance —
  // snap the roster view back to "My roster". Saves and picks reuse the same
  // engine, so a mid-draft team selection sticks.
  useEffect(() => setRosterSlot(store.humanSlot ?? 1), [engine, store.humanSlot]);

  const playerById = useMemo(() => indexById(players), [players]);

  // Available = engine pool once started; pre-draft shows the full list (kept
  // players stay visible with a badge so they can be re-assigned or cleared).
  const available: Player[] = useMemo(() => {
    if (engine) {
      return engine.availablePlayers().map((e) => playerById.get(e.id)!).filter(Boolean);
    }
    return players;
  }, [engine, players, playerById, store.version]);

  // Selected team's optimized lineup: starters by slot, bench, empty needs.
  // Roster = completed picks + reserved keepers, so kept players show at once.
  const lineup = useMemo(() => {
    if (!engine || !started) return null;
    const roster = engine
      .teamPlayerIds(rosterSlot)
      .map((id) => playerById.get(id))
      .filter(Boolean) as Player[];
    return optimizeLineup(roster, config.rosterSlots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, started, rosterSlot, config.rosterSlots, playerById, store.version]);

  // playerId -> the keeper cell they're a candidate in (for badges + the editor).
  const keeperByPlayer = useMemo(() => {
    const m = new Map<string, { round: number; teamSlot: number; prob: number }>();
    for (const c of store.cells.values()) {
      for (const o of c.keepers ?? []) m.set(o.playerId, { round: c.round, teamSlot: c.teamSlot, prob: o.prob });
    }
    return m;
  }, [store.cells]);

  // Universal search box (name / position / team / bye / tag; predicate in
  // lib/util) working alongside the quick position-filter buttons.
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = available
    .filter((p) => filter === 'ALL' || p.position === filter)
    .filter((p) => matchesQuery(p, tokens))
    .sort((a, b) => a.adp - b.adp)
    .slice(0, 80);

  const selected = selectedId ? playerById.get(selectedId) ?? null : null;
  const humanOnClock = engine?.isHumanOnClock ?? false;
  const current = engine?.currentPick;
  const complete = engine?.isComplete ?? false;

  return (
    <div className="panel">
      <h2>
        {started ? (complete ? 'Draft Complete' : 'Player Pool') : 'Pre-Draft Lobby'}
      </h2>

      {started && humanOnClock && current && (
        <div className="onclock-banner">
          <strong>You're on the clock</strong> — Round {current.round}, Pick #{current.overall}.
          Pick a player below.
        </div>
      )}
      {started && !humanOnClock && !complete && (
        <div className="onclock-banner" style={{ borderColor: 'var(--warn)', background: 'rgba(245,158,11,0.12)' }}>
          Paused{current ? ` at pick #${current.overall}` : ''} — inspect the board, then{' '}
          <button className="mini" onClick={store.autoToHuman}>Resume ▶</button> (or press <b>Enter</b>), or <b>Step</b> one pick.
        </div>
      )}

      {started && engine && lineup && (
        <div style={{ marginBottom: 10 }}>
          <div className="row">
            <select value={rosterSlot} onChange={(e) => setRosterSlot(Number(e.target.value))}>
              {range1(config.teamCount).map((s) => (
                <option key={s} value={s}>
                  {s === store.humanSlot ? 'My roster' : `Team ${s}`}
                </option>
              ))}
            </select>
            <span className="num">{Math.round(lineup.startingPoints)} starter pts</span>
          </div>
          {lineup.starters.map((seat, i) => <StarterRow key={i} seat={seat} />)}
          {byeClashes(lineup.starters.map((s) => s.player).filter(Boolean) as Player[]).map((c) => (
            <div key={c.week} className="num" style={{ color: 'var(--warn)' }}>
              ⚠ {c.count} starters share Bye {c.week}
            </div>
          ))}
          {lineup.bench.length > 0 && (
            <div className="num" style={{ marginTop: 4 }}>
              Bench: {lineup.bench.map((p) => p.name).join(', ')}
            </div>
          )}
        </div>
      )}

      <input
        placeholder="Search name, position, team, bye (bye9), tag…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
      />

      <div className="flex-wrap" style={{ marginBottom: 10 }}>
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            className="mini"
            style={filter === pos ? { borderColor: 'var(--accent)', background: 'var(--accent)' } : undefined}
            onClick={() => setFilter(pos)}
          >
            {pos}
          </button>
        ))}
      </div>

      {selected && (
        <PlayerInspector
          key={selected.id}
          player={selected}
          started={started}
          canPick={humanOnClock}
          keeper={keeperByPlayer.get(selected.id) ?? null}
          teamCount={config.teamCount}
          roundCount={config.roundCount}
          onClose={() => setSelectedId(null)}
        />
      )}

      <div className="pool">
        {shown.map((p) => (
          <div
            className={'player-row' + (p.id === selectedId ? ' selected' : '')}
            key={p.id}
            onClick={() => setSelectedId((cur) => (cur === p.id ? null : p.id))}
          >
            <span className={`pos ${p.position}`}>{p.position}</span>
            <span>
              <span className="name">{p.name}</span>{' '}
              <span className="num">{playerMeta(p)}</span>
              {keeperByPlayer.has(p.id) && (
                <span className="badge" style={{ marginLeft: 6 }}>
                  🔒 T{keeperByPlayer.get(p.id)!.teamSlot} R{keeperByPlayer.get(p.id)!.round}
                </span>
              )}
            </span>
            <span className="num">ADP {p.adp}</span>
            <span className="num">{p.projPoints} pts</span>
            {started ? (
              <button
                className="mini primary"
                disabled={!humanOnClock}
                onClick={(e) => { e.stopPropagation(); store.makePick(p.id); }}
              >
                Draft
              </button>
            ) : (
              <button className="mini">{p.id === selectedId ? 'Editing' : 'Edit'}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// One shared inspector for the selected player — renders in normal flow (never
// clipped by the scrolling pool) and generalizes five actions into one surface:
// draft, ADP override, projection override, injury what-if, and keeper assign.
function PlayerInspector({
  player,
  started,
  canPick,
  keeper,
  teamCount,
  roundCount,
  onClose,
}: {
  player: Player;
  started: boolean;
  canPick: boolean;
  keeper: { round: number; teamSlot: number; prob?: number } | null;
  teamCount: number;
  roundCount: number;
  onClose: () => void;
}) {
  const store = useDraftStore();
  // Keeper target defaults to the player's current cell, else Team 1 / Round 1.
  const [team, setTeam] = useState(keeper?.teamSlot ?? 1);
  const [round, setRound] = useState(keeper?.round ?? 1);
  // Keep probability as a percent (100 = certain).
  const [keepPct, setKeepPct] = useState(Math.round((keeper?.prob ?? 1) * 100));

  // One numeric player-override row (ADP, projection, …): edit-on-blur, one place.
  const numRow = (label: string, value: number, apply: (n: number) => void) => (
    <div className="row">
      <label>{label}</label>
      <input
        type="number"
        defaultValue={value}
        style={{ width: 80 }}
        onBlur={(e) => apply(Number(e.target.value))}
      />
    </div>
  );

  return (
    <div className="panel inspector">
      <div className="row">
        <span className="truncate">
          <span className={`pos ${player.position}`}>{player.position}</span>{' '}
          <b>{player.name}</b> <span className="num">{playerMeta(player)}</span>
        </span>
        <button className="mini" onClick={onClose}>✕</button>
      </div>

      {started && (
        <button
          className="mini primary"
          style={{ width: '100%', marginBottom: 8 }}
          disabled={!canPick}
          onClick={() => store.makePick(player.id)}
        >
          Draft {player.name}
        </button>
      )}

      {numRow('ADP', player.adp, (n) => store.overridePlayer(player.id, { adp: n }))}
      {numRow('Proj pts', player.projPoints, (n) => store.overridePlayer(player.id, { projPoints: n }))}
      <button
        className="mini"
        style={{ width: '100%', marginTop: 6 }}
        onClick={() => store.overridePlayer(player.id, { projPoints: 0 })}
      >
        💀 Injure (proj → 0)
      </button>

      {!started && (
        <>
          <div className="row" style={{ marginTop: 10 }}>
            <label>Keeper</label>
            <span>
              <select value={team} onChange={(e) => setTeam(Number(e.target.value))}>
                {range1(teamCount).map((t) => (
                  <option key={t} value={t}>T{t}</option>
                ))}
              </select>{' '}
              <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
                {range1(roundCount).map((r) => (
                  <option key={r} value={r}>R{r}</option>
                ))}
              </select>{' '}
              <input
                type="number"
                min={1}
                max={100}
                value={keepPct}
                onChange={(e) => setKeepPct(Number(e.target.value))}
                style={{ width: 55 }}
                title="Chance this keeper is actually kept (each mock re-rolls it)"
              />%
            </span>
          </div>
          <button
            className="mini primary"
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => store.setKeeper(round, team, player.id, keepPct / 100)}
          >
            🔒 Keep at T{team} R{round} ({keepPct}%)
          </button>
          {keeper && (
            <button
              className="mini"
              style={{ width: '100%', marginTop: 6 }}
              onClick={() => store.setKeeper(keeper.round, keeper.teamSlot, player.id, 0)}
            >
              ✕ Remove keeper
            </button>
          )}
        </>
      )}
    </div>
  );
}
