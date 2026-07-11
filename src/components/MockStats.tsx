import { useMemo, useState } from 'react';
import { useDraftStore } from '../store/draftStore';
import { listSessions } from '../store/sessions';
import { useCompare } from '../store/compare';
import { mockStats } from '../engine/mockStats';
import { playerMeta, matchesQuery } from '../lib/util';

/** Cross-mock analytics as a non-blocking slide-in rail: opens at 2+ selected
 *  drafts and updates live as you tick more (the setup panel stays interactive). */
export function MockStats() {
  const store = useDraftStore();
  const compare = useCompare();
  const [q, setQ] = useState('');
  const [min, setMin] = useState(false);
  const recs = listSessions().filter((sn) => compare.ids.includes(sn.id));
  const r = useMemo(
    () => mockStats(recs.map((s) => ({ name: s.name, ...s.snap }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compare.ids.join(','), store.version],
  );
  if (recs.length < 2) return null;
  const n = r.drafts;
  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="row"><label>{label}</label><span className="num">{value}</span></div>
  );
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (tokens.length ? r.players.filter((s) => matchesQuery(s.player, tokens)) : r.players).slice(0, 40);

  if (min) return <button className="rail-tab" title="Show Mock Stats" onClick={() => setMin(false)}>◂ Mock Stats · {n}</button>;
  return (
    <div className="rail panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Mock Stats · {n} drafts</h2>
        <span><button className="mini" title="Minimize" onClick={() => setMin(true)}>–</button>{' '}<button className="mini" onClick={compare.clear}>✕</button></span>
      </div>

      <h3>Your team</h3>
      <Stat label="Starter pts (median)" value={`${Math.round(r.starterMedian)}`} />
      <Stat label="Floor–ceiling (p10–p90)" value={`${Math.round(r.starterFloor)} – ${Math.round(r.starterCeiling)}`} />
      <Stat label="Mean ± σ" value={`${Math.round(r.starterMean)} ± ${Math.round(r.starterStd)}`} />
      <Stat label="Best / worst draft" value={`${r.bestDraft} / ${r.worstDraft}`} />
      <Stat label="Your slot (× drafts)" value={r.yourSlots.map((s) => `#${s.slot}×${s.count}`).join(' · ') || '—'} />

      <h3>Player market</h3>
      <input placeholder="Search any player…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
      <div className="player-row mkt-row" style={{ color: 'var(--muted)', fontWeight: 600 }}>
        <span /><span /><span className="num">pick</span><span className="num">kept</span><span className="num">yours</span>
      </div>
      {shown.map((s) => (
        <div className="player-row mkt-row" key={s.player.name}>
          <span className={`pos ${s.player.position}`}>{s.player.position}</span>
          <span><span className="name">{s.player.name}</span> <span className="num">{playerMeta(s.player)}</span></span>
          <span className="num">{s.avgPick.toFixed(1)}</span>
          <span className="num">{s.kept || ''}</span>
          <span className="num" style={s.yours ? { color: 'var(--accent)' } : undefined}>{Math.round((100 * s.yours) / n)}%</span>
        </div>
      ))}
    </div>
  );
}
