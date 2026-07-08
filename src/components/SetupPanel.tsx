import { useDraftStore } from '../store/draftStore';
import { listSessions, type SessionRec } from '../store/sessions';
import { useCompare } from '../store/compare';
import { MODIFIER_LIBRARY } from '../data/presets';
import { listDatasets } from '../data/datasets';
import { BrainSliders } from './BrainSliders';
import { range1 } from '../lib/util';
import { useRef, useState, type ChangeEvent } from 'react';
import type { RosterSlot } from '../types';

// Roster spots <-> one compact text field, e.g. "QB1 RB2 WR2 TE1 FLEX1 BENCH6".
const rosterToText = (r: Partial<Record<RosterSlot, number>>) =>
  Object.entries(r).map(([k, v]) => `${k}${v}`).join(' ');
const parseRoster = (t: string): Partial<Record<RosterSlot, number>> => {
  const out: Partial<Record<RosterSlot, number>> = {};
  for (const m of t.toUpperCase().matchAll(/([A-Z]+)\s*(\d+)/g)) out[m[1] as RosterSlot] = Number(m[2]);
  return out;
};

const MODIFIER_LABELS: Record<keyof typeof MODIFIER_LIBRARY, string> = {
  tePremium: 'TE Premium (TE ×1.5 pts)',
  superflex: 'Superflex (max 2 QB)',
  devyRookieBoost: 'Devy/Dynasty (Rookie ADP +20%)',
};

export function SetupPanel() {
  const store = useDraftStore();
  const compare = useCompare();
  const { config, modifiers, teams, humanSlot } = store;
  const [editSlot, setEditSlot] = useState(1);
  const [sessName, setSessName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const readText = (file: File, use: (text: string) => void) => {
    const reader = new FileReader();
    reader.onload = () => use(String(reader.result));
    reader.readAsText(file);
  };
  const onUpload = (file: File) =>
    readText(file, (t) => store.uploadDataset(file.name.replace(/\.csv$/i, ''), t));

  // Portable drafts: snapshots are self-contained, so one JSON file holds a draft
  // (or the whole log). This file lives on YOUR disk — the durable backup that
  // survives a cleared browser, a new profile, or a port change.
  const download = (data: unknown, name: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportSession = (sn: SessionRec) => download(sn, `${sn.name}.rockurmock.json`);
  const exportAll = () => download(listSessions(), `rock-ur-mock-backup-${new Date().toISOString().slice(0, 10)}.json`);
  // Import restores either a single draft (object) or a full backup (array).
  const onImport = (file: File) =>
    readText(file, (t) => {
      const data = JSON.parse(t);
      Array.isArray(data) ? store.importAll(data) : store.importSession(data);
    });
  // Hidden-input change → the first file, then reset so re-picking the same file fires again.
  const pickFile = (onFile: (f: File) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = '';
  };

  const isOn = (key: keyof typeof MODIFIER_LIBRARY) =>
    modifiers.some(
      (m) =>
        m.matchTag === MODIFIER_LIBRARY[key].matchTag &&
        m.action === MODIFIER_LIBRARY[key].action,
    );

  const editingTeam = teams.find((t) => t.slot === editSlot) ?? teams[0];

  return (
    <div>
      <div className="panel">
        <h2>Base Data</h2>
        <div className="row">
          <label>Rankings</label>
          <select
            className="truncate"
            value={store.datasetId}
            onChange={(e) => store.setDataset(e.target.value)}
            disabled={store.started}
          >
            {listDatasets().map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>{store.players.length} players</label>
          <button
            className="mini"
            disabled={store.started}
            onClick={() => fileRef.current?.click()}
          >
            Upload CSV…
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          style={{ display: 'none' }}
          onChange={pickFile(onUpload)}
        />
      </div>

      <div className="panel">
        <h2>League</h2>
        <div className="row">
          <label>Teams</label>
          <select
            value={config.teamCount}
            onChange={(e) => store.setConfig({ teamCount: Number(e.target.value) })}
          >
            {[8, 10, 12, 14].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Rounds</label>
          <input
            type="number"
            min={1}
            max={20}
            value={config.roundCount}
            onChange={(e) => store.setConfig({ roundCount: Number(e.target.value) })}
            style={{ width: 64 }}
          />
        </div>
        <div className="row">
          <label>Keepers/team</label>
          <input
            type="number"
            min={0}
            max={20}
            // Blank = no limit (the default), a number = a hard cap. 0 keeps none.
            value={config.keeperCount ?? ''}
            onChange={(e) =>
              store.setConfig({ keeperCount: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            style={{ width: 64 }}
            placeholder="∞"
            title="Max keepers kept per team — blank = no limit, 0 = none"
          />
        </div>
        <div className="row">
          <label>Roster</label>
          <input
            key={rosterToText(config.rosterSlots)}
            defaultValue={rosterToText(config.rosterSlots)}
            onBlur={(e) => store.setConfig({ rosterSlots: parseRoster(e.target.value) })}
            style={{ width: 160 }}
          />
        </div>
        <div className="row">
          <label>Order</label>
          <select
            value={config.preset}
            onChange={(e) => store.setConfig({ preset: e.target.value as 'snake' | 'linear' })}
            disabled={store.started}
          >
            <option value="snake">Snake</option>
            <option value="linear">Linear</option>
          </select>
        </div>
        <div className="row">
          <label>Your seat</label>
          <select
            value={humanSlot ?? 'none'}
            onChange={(e) =>
              store.setHumanSlot(e.target.value === 'none' ? null : Number(e.target.value))
            }
            disabled={store.started}
          >
            <option value="none">Spectate (all bots)</option>
            {range1(config.teamCount).map((s) => (
              <option key={s} value={s}>Team {s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel">
        <h2>Universal Modifiers</h2>
        {(Object.keys(MODIFIER_LABELS) as (keyof typeof MODIFIER_LIBRARY)[]).map((key) => (
          <label className="toggle" key={key}>
            <input
              type="checkbox"
              checked={isOn(key)}
              onChange={() => store.toggleModifier(key)}
              disabled={store.started}
            />
            <span>{MODIFIER_LABELS[key]}</span>
          </label>
        ))}
      </div>

      <div className="panel">
        <h2>Bot Brains</h2>
        <div className="row">
          <label>Editing</label>
          <select value={editSlot} onChange={(e) => setEditSlot(Number(e.target.value))}>
            {teams.map((t) => (
              <option key={t.slot} value={t.slot} disabled={t.slot === humanSlot}>
                {t.name} {t.slot === humanSlot ? '(you)' : ''}
              </option>
            ))}
          </select>
        </div>
        {editingTeam.slot !== humanSlot && (
          <BrainSliders
            brain={editingTeam.brain}
            onChange={(b) => store.setBrain(editingTeam.slot, b)}
          />
        )}
      </div>

      <div className="panel">
        <h2>Drafts</h2>
        <div className="row">
          <input
            placeholder="Save current as…"
            value={sessName}
            onChange={(e) => setSessName(e.target.value)}
            style={{ width: 120 }}
          />
          <span>
            <button
              className="mini primary"
              onClick={() => { store.saveSession(sessName.trim() || 'Untitled'); setSessName(''); }}
            >
              Save
            </button>{' '}
            <button className="mini" title="Restore a draft or a full backup file" onClick={() => importRef.current?.click()}>Import</button>
          </span>
        </div>
        {listSessions().length > 0 && (
          <div className="row">
            <label className="truncate">{listSessions().length} saved · back up to a file</label>
            <button className="mini primary" onClick={exportAll}>⤓ Backup all</button>
          </div>
        )}
        {listSessions().map((sn) => {
          const open = sn.id === store.activeSessionId;
          return (
          <div className={'row' + (open ? ' open-row' : '')} key={sn.id}>
            <label className="truncate">
              <input
                type="checkbox"
                title="Compare in Mock Stats (check 2+ drafts)"
                checked={compare.ids.includes(sn.id)}
                onChange={() => compare.toggle(sn.id)}
              />{' '}
              <b>{sn.name}</b> · <span className="num">{open ? 'open' : sn.status}</span>
            </label>
            <span>
              <button className={'mini' + (open ? ' primary' : '')} onClick={() => store.loadSession(sn.id)}>Open</button>{' '}
              <button className="mini" onClick={() => exportSession(sn)}>⤓</button>{' '}
              <button className="mini" onClick={() => store.deleteSession(sn.id)}>✕</button>
            </span>
          </div>
          );
        })}
        <input
          ref={importRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={pickFile(onImport)}
        />
      </div>
    </div>
  );
}
