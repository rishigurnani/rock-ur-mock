import type { Brain } from '../types';
import { PRESETS } from '../engine/bot';

const SLIDERS: [keyof Brain, string][] = [
  ['adpBias', 'VBD ↔ ADP'],
  ['chaos', 'Chaos / Reach'],
  ['rosterNeed', 'Roster Needs'],
  ['ageUpside', 'Age / Upside'],
];

export function BrainSliders({
  brain,
  onChange,
}: {
  brain: Brain;
  onChange: (b: Brain) => void;
}) {
  return (
    <div>
      <div className="row">
        <label>Preset</label>
        <select
          value={matchPreset(brain)}
          onChange={(e) => {
            const p = PRESETS[e.target.value];
            if (p) onChange({ ...p });
          }}
        >
          {Object.keys(PRESETS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
          <option value="custom">custom</option>
        </select>
      </div>
      {SLIDERS.map(([key, label]) => (
        <div className="slider-row" key={key}>
          <label>{label}</label>
          <input
            type="range"
            min={0}
            max={100}
            value={brain[key]}
            onChange={(e) => onChange({ ...brain, [key]: Number(e.target.value) })}
          />
          <span className="num">{brain[key]}</span>
        </div>
      ))}
    </div>
  );
}

const sameBrain = (a: Brain, b: Brain) =>
  (Object.keys(a) as (keyof Brain)[]).every((k) => a[k] === b[k]);

function matchPreset(brain: Brain): string {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (sameBrain(p, brain)) return name;
  }
  return 'custom';
}
