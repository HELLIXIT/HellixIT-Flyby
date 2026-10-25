'use client';

import { useMemo } from 'react';
import type { Aircraft, EstimatedAircraft, Units } from '@/lib/types';
import { altColor, compass, fmtAlt, fmtDist, skyPosition } from '@/lib/flight';

interface Props {
  location: { lat: number; lon: number } | null;
  locating: boolean;
  locError: string | null;
  aircraft: Aircraft[];
  /** Estimated (no-signal) planes — shown dashed on the radar and marked in the list. */
  estimated: EstimatedAircraft[];
  radiusNm: number;
  units: Units;
  onRadius: (nm: number) => void;
  onLocate: () => void;
  onSelect: (a: Aircraft) => void;
  onEstimated: (e: EstimatedAircraft) => void;
  onClose: () => void;
  voiceOn: boolean;
  voiceSupported: boolean;
  caption: string | null;
  onToggleVoice: () => void;
}

interface Item {
  a: Aircraft;
  est: EstimatedAircraft | null;
  sky: { distanceNm: number; bearing: number; elevation: number };
}

const MIN_NM = 5;
const MAX_NM = 150;

/** "What's that plane?" — aircraft around the user, with where to look in the sky. */
export default function OverheadPanel(p: Props) {
  const list = useMemo<Item[]>(() => {
    if (!p.location) return [];
    const live: Item[] = p.aircraft.filter((a) => !a.onGround).map((a) => ({ a, est: null, sky: skyPosition(p.location!, a) }));
    const est: Item[] = p.estimated.map((e) => {
      const a: Aircraft = {
        hex: e.hex, callsign: e.flightNumber ?? e.callsign, reg: e.reg, type: e.type, desc: null, lat: e.lat, lon: e.lon,
        alt: e.alt, onGround: false, gs: e.gs, track: e.track, vrate: null, squawk: null, emergency: null,
        category: null, military: false, seen: e.silentSec, source: 'estimate',
      };
      return { a, est: e, sky: skyPosition(p.location!, a) };
    });
    return [...live, ...est].filter((x) => x.sky.distanceNm <= p.radiusNm).sort((x, y) => y.sky.elevation - x.sky.elevation);
  }, [p.aircraft, p.estimated, p.location, p.radiusNm]);
  const pick = (x: Item) => (x.est ? p.onEstimated(x.est) : p.onSelect(x.a));

  return (
    <div className="panel-body">
      <header className="fp-head">
        <div>
          <div className="fp-title">Above me</div>
          <div className="muted">Spot the plane you can see or hear</div>
        </div>
        <div className="fp-actions">
          {p.voiceSupported && (
            <button
              className={`icon-btn ${p.voiceOn ? 'on-voice' : ''}`}
              onClick={p.onToggleVoice}
              title={p.voiceOn ? 'Turn voice announcements off' : 'Turn voice announcements on'}
              aria-pressed={p.voiceOn}
            >
              {p.voiceOn ? '🔊' : '🔇'}
            </button>
          )}
          <button className="icon-btn" onClick={p.onLocate} title="Update my location">
            ◎
          </button>
          <button className="icon-btn" onClick={p.onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      {!p.location && (
        <section className="card">
          <p>{p.locating ? 'Finding your location…' : p.locError ?? 'Share your location to see aircraft flying near you.'}</p>
          {!p.locating && (
            <button className="btn primary" onClick={p.onLocate}>
              📍 Use my location
            </button>
          )}
          <p className="small muted">Your location stays in your browser — it is only used to pick the map area.</p>
        </section>
      )}

      {p.location && (
        <>
          {p.voiceOn && (
            <div className="voice-caption" aria-live="polite">
              <span>🔊</span>
              <span>{p.caption ?? 'Listening for aircraft entering, turning and leaving the radar…'}</span>
            </div>
          )}
          <section className="card radar-card">
            <Radar items={list} radiusNm={p.radiusNm} onPick={pick} />
            <div className="seg" role="radiogroup" aria-label="Radius presets">
              {[10, 25, 50, 100].map((r) => (
                <button key={r} role="radio" aria-checked={p.radiusNm === r} className={p.radiusNm === r ? 'active' : ''} onClick={() => p.onRadius(r)}>
                  {fmtDist(r, p.units)}
                </button>
              ))}
            </div>
            <label className="radius-slider">
              <span className="small muted">Range</span>
              <input
                type="range"
                min={MIN_NM}
                max={MAX_NM}
                step={1}
                value={p.radiusNm}
                onChange={(e) => p.onRadius(Number(e.target.value))}
                aria-label="Radar range"
              />
              <b className="small">{fmtDist(p.radiusNm, p.units)}</b>
            </label>
          </section>

          <section className="card">
            <h3>
              {list.length} aircraft within {fmtDist(p.radiusNm, p.units)}
            </h3>
            {list.length === 0 && <p className="muted small">Quiet skies right now. Try a bigger radius.</p>}
            <ul className="board">
              {list.slice(0, 40).map((x) => {
                const { a, sky, est } = x;
                return (
                <li key={`${est ? 'e' : 'l'}${a.hex}`}>
                  <button className="over-row" onClick={() => pick(x)}>
                    <span className={`over-dot ${est ? 'est' : ''}`} style={{ background: est ? 'transparent' : altColor(a), borderColor: altColor(a) }} />
                    <span className="over-main">
                      <b className="mono">
                        {a.callsign ?? a.reg ?? a.hex.toUpperCase()}
                        {est && <span className="pill warn est-pill">est.</span>}
                      </b>
                      <span className="muted small">
                        {est
                          ? `${est.origin?.iata ?? '?'} → ${est.destination?.iata ?? '?'} · no live signal`
                          : `${a.type ?? 'Unknown type'} · ${fmtAlt(a.alt, p.units)}`}
                      </span>
                    </span>
                    <span className="over-look">
                      <b>
                        {compass(sky.bearing)} {Math.round(sky.elevation)}°↑
                      </b>
                      <span className="muted small">{fmtDist(sky.distanceNm, p.units)}</span>
                    </span>
                  </button>
                </li>
                );
              })}
            </ul>
            <p className="small muted">“NE 35°↑” means look north-east, about a third of the way up from the horizon (90° is straight overhead).</p>
          </section>
        </>
      )}
    </div>
  );
}

function Radar({ items, radiusNm, onPick }: { items: Item[]; radiusNm: number; onPick: (x: Item) => void }) {
  const size = 220;
  const c = size / 2;
  const r = c - 14;
  return (
    <svg className="radar" viewBox={`0 0 ${size} ${size}`} width="100%" role="img" aria-label="Radar view of aircraft around you">
      {[1, 0.66, 0.33].map((f) => (
        <circle key={f} cx={c} cy={c} r={r * f} className="radar-ring" />
      ))}
      <line x1={c} y1={c - r} x2={c} y2={c + r} className="radar-ring" />
      <line x1={c - r} y1={c} x2={c + r} y2={c} className="radar-ring" />
      <g className="radar-sweep">
        <path d={`M${c},${c} L${c},${c - r} A${r},${r} 0 0,1 ${c + r * Math.sin(Math.PI / 6)},${c - r * Math.cos(Math.PI / 6)} Z`} />
      </g>
      {['N', 'E', 'S', 'W'].map((d, i) => (
        <text key={d} x={c + Math.sin((i * Math.PI) / 2) * (r + 8)} y={c - Math.cos((i * Math.PI) / 2) * (r + 8) + 4} className="radar-label">
          {d}
        </text>
      ))}
      {items.map((x) => {
        const d = (x.sky.distanceNm / radiusNm) * r;
        const px = c + Math.sin((x.sky.bearing * Math.PI) / 180) * d;
        const py = c - Math.cos((x.sky.bearing * Math.PI) / 180) * d;
        const color = altColor(x.a);
        return (
          <g key={`${x.est ? 'e' : 'l'}${x.a.hex}`} className={`blip ${x.est ? 'blip-est' : ''}`} onClick={() => onPick(x)}>
            {x.est ? (
              <circle cx={px} cy={py} r={4.5} fill="none" stroke="#fbbf24" strokeWidth={1.4} strokeDasharray="2 1.5" />
            ) : (
              <circle cx={px} cy={py} r={4.5} fill={color} />
            )}
            <text x={px + 6} y={py + 3}>
              {(x.a.callsign ?? '') + (x.est ? ' est.' : '')}
            </text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r={4} className="radar-me" />
    </svg>
  );
}
