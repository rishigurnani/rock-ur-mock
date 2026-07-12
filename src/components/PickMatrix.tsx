import { useMemo, type MouseEvent } from 'react';
import { useDraftStore } from '../store/draftStore';
import type { CompletedPick, Player } from '../types';
import { resolvePickOrder, keptPlayerId, keeperCandidates } from '../engine/matrix';
import { indexById, range1 } from '../lib/util';

export function PickMatrix() {
  // Subscribe to the whole store; `version` bumps re-render after engine mutations.
  const store = useDraftStore();
  const { players, config, cells, engine, version } = store;

  const playerById = useMemo(() => indexById(players), [players]);

  // Preview order (pre-draft) or the live engine order.
  const order = useMemo(
    () =>
      engine
        ? engine.order
        : resolvePickOrder({
            teamCount: config.teamCount,
            roundCount: config.roundCount,
            preset: config.preset,
            defaultTimerSeconds: 60,
            cells,
          }),
    [engine, config, cells],
  );

  const completedByOverall = useMemo(() => {
    const m = new Map<number, CompletedPick>();
    if (engine) for (const c of engine.completed) m.set(c.overall, c);
    return m;
  }, [engine, version]);

  const currentOverall = engine?.currentPick?.overall ?? -1;

  // Index resolved picks by round -> teamSlot(board column).
  const byRoundSlot = new Map<string, (typeof order)[number]>();
  for (const p of order) byRoundSlot.set(`${p.round}:${p.teamSlot}`, p);

  const teamSlots = range1(config.teamCount);
  const rounds = range1(config.roundCount);

  // Right-click a completed pick to rewind the live draft back to it. Guarded —
  // it discards every pick made after this one (bots then re-run forward).
  const rewind = (e: MouseEvent, overall: number) => {
    e.preventDefault();
    if (window.confirm(`Rewind the draft to pick #${overall}? Later picks are discarded.`)) store.rewindTo(overall);
  };

  return (
    <div className="panel">
      <h2>Pick Matrix</h2>
      <div className="board-wrap">
        <table className="board">
          <thead>
            <tr>
              <th>R</th>
              {teamSlots.map((s) => (
                <th key={s}>
                  Team {s}
                  {/* Pre-draft: nudge a team's seat to switch draft position. */}
                  {!engine && (
                    <span className="seat-swap">
                      <button className="mini" disabled={s === 1} onClick={() => store.swapSlots(s, s - 1)} title="Move earlier">◀</button>
                      <button className="mini" disabled={s === config.teamCount} onClick={() => store.swapSlots(s, s + 1)} title="Move later">▶</button>
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round}>
                <td className="rnd">{round}</td>
                {teamSlots.map((slot) => {
                  const pick = byRoundSlot.get(`${round}:${slot}`);
                  if (!pick) return <td key={slot} className="cell empty">—</td>;
                  const done = completedByOverall.get(pick.overall);
                  const candidates = keeperCandidates(pick);
                  const isKeeper = candidates.length > 0;
                  // A completed pick or a lone resolved keeper shows one player;
                  // an unrolled cell with rival candidates lists them all.
                  const occupantId = done?.playerId ?? keptPlayerId(pick);
                  const player = occupantId ? playerById.get(occupantId) : undefined;
                  const soleProb = candidates.length === 1 ? candidates[0].prob : undefined;
                  const onClock = pick.overall === currentOverall;
                  const traded = pick.owningTeamSlot !== pick.teamSlot;

                  return (
                    <td
                      key={slot}
                      className={
                        'cell' +
                        (onClock ? ' onclock' : '') +
                        (isKeeper ? ' keeper' : '')
                      }
                      title={done?.trace ? traceText(done, playerById) : undefined}
                      onContextMenu={done ? (e) => rewind(e, pick.overall) : undefined}
                    >
                      {player ? (
                        <div className="pname">
                          <span className={`pos ${player.position}`}>{player.position}</span>{' '}
                          {player.name}
                        </div>
                      ) : candidates.length > 1 ? (
                        <div className="pname">
                          {candidates.map((o) => (
                            <div key={o.playerId}>
                              {playerById.get(o.playerId)?.name ?? '?'} · {Math.round(o.prob * 100)}%
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="meta">
                        #{pick.overall}
                        {traded ? ` · via T${pick.owningTeamSlot}` : ''}
                        {isKeeper
                          ? candidates.length > 1
                            ? ' · KEEP?'
                            : soleProb != null && soleProb < 1
                              ? ` · KEEP ${Math.round(soleProb * 100)}%`
                              : ' · KEEPER'
                          : ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function traceText(done: CompletedPick, players: Map<string, Player>): string {
  const t = done.trace!;
  const name = players.get(done.playerId)?.name ?? done.playerId;
  return (
    `${name} — Score ${t.finalScore}\n` +
    `Base ${t.baseValue} (${t.adpBlendLabel})\n` +
    `× Need ${t.needMultiplier}  × Age ${t.ageMultiplier}  × Chaos ${t.chaosRoll}`
  );
}
