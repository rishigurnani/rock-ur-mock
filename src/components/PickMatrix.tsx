import { useMemo } from 'react';
import { useDraftStore } from '../store/draftStore';
import type { CompletedPick, Player } from '../types';
import { resolvePickOrder } from '../engine/matrix';
import { indexById, range1 } from '../lib/util';

export function PickMatrix() {
  // Subscribe to the whole store; `version` bumps re-render after engine mutations.
  const { players, config, cells, engine, version } = useDraftStore();

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

  return (
    <div className="panel">
      <h2>Pick Matrix</h2>
      <div className="board-wrap">
        <table className="board">
          <thead>
            <tr>
              <th>R</th>
              {teamSlots.map((s) => (
                <th key={s}>Team {s}</th>
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
                  const isKeeper = !!pick.keeperPlayerId;
                  // One occupant resolver: a completed pick, or a pre-filled
                  // keeper, or nobody yet. Keepers therefore show their player
                  // before the draft starts, live, and after a save/restore.
                  const occupantId = done?.playerId ?? pick.keeperPlayerId;
                  const player = occupantId ? playerById.get(occupantId) : undefined;
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
                    >
                      {player && (
                        <div className="pname">
                          <span className={`pos ${player.position}`}>{player.position}</span>{' '}
                          {player.name}
                        </div>
                      )}
                      <div className="meta">
                        #{pick.overall}
                        {traded ? ` · via T${pick.owningTeamSlot}` : ''}
                        {isKeeper ? ' · KEEPER' : ''}
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
