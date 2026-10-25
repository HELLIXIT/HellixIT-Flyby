'use client';

import { useEffect, useState } from 'react';
import type { Aircraft, Filters, Settings, Units, WatchItem } from '@/lib/types';
import { PHASE_EMOJI, PHASE_LABEL, altColor, fmtAlt, fmtSpeed, phaseOf } from '@/lib/flight';

function Head({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <header className="fp-head">
      <div>
        <div className="fp-title">{title}</div>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <div className="fp-actions">
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- My Flights

export function WatchlistPanel(p: {
  items: WatchItem[];
  live: Record<string, Aircraft | null | undefined>;
  units: Units;
  notifications: boolean;
  onEnableNotifications: () => void;
  onSelect: (hex: string) => void;
  onRemove: (hex: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="panel-body">
      <Head title="My Flights" sub="Starred flights are checked every 20 s" onClose={p.onClose} />
      {!p.notifications && p.items.length > 0 && (
        <div className="notice">
          Get notified on takeoff, descent, landing and emergencies.{' '}
          <button className="btn small primary" onClick={p.onEnableNotifications}>
            Enable alerts
          </button>
        </div>
      )}
      {p.items.length === 0 && (
        <section className="card empty">
          <div className="empty-icon">☆</div>
          <p>No saved flights yet.</p>
          <p className="small muted">Open any flight and tap the star. We’ll track it for you and tell you when it takes off, starts descending and lands — plus when to leave for the airport.</p>
        </section>
      )}
      <ul className="board">
        {p.items.map((w) => {
          const a = p.live[w.hex];
          const phase = a ? phaseOf(a) : null;
          return (
            <li key={w.hex} className="watch-row">
              <button className="watch-main" onClick={() => p.onSelect(w.hex)}>
                <span className="over-dot" style={{ background: a ? altColor(a) : '#64748b' }} />
                <span className="over-main">
                  <b className="mono">{w.label}</b>
                  <span className="muted small">
                    {w.hex.startsWith('cs:')
                      ? `📡 Waiting for signal${w.routeLabel ? ` · ${w.routeLabel}` : ''} — not in receiver coverage yet`
                      : a === undefined
                      ? 'Checking…'
                      : a === null
                        ? 'Not transmitting (landed or out of range)'
                        : `${PHASE_EMOJI[phase!]} ${PHASE_LABEL[phase!]} · ${fmtAlt(a.alt, p.units, a.onGround)} · ${fmtSpeed(a.gs, p.units)}`}
                  </span>
                </span>
              </button>
              <button className="icon-btn" title="Remove" onClick={() => p.onRemove(w.hex)}>
                🗑
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Alerts

export function AlertsPanel(p: {
  alerts: Aircraft[] | null;
  military: Aircraft[] | null;
  showMilitary: boolean;
  units: Units;
  onToggleMilitary: () => void;
  onSelect: (a: Aircraft) => void;
  onClose: () => void;
}) {
  return (
    <div className="panel-body">
      <Head title="Alerts" sub="Worldwide emergency squawks, live" onClose={p.onClose} />
      <section className="card">
        <h3>🚨 Emergencies</h3>
        {p.alerts === null && <div className="skeleton" style={{ height: 60 }} />}
        {p.alerts?.length === 0 && <p className="muted small">No aircraft are squawking an emergency right now. 🎉</p>}
        <ul className="board">
          {p.alerts?.map((a) => (
            <li key={a.hex}>
              <button className="board-row" onClick={() => p.onSelect(a)}>
                <b className="mono">{a.callsign ?? a.reg ?? a.hex.toUpperCase()}</b>
                <span className="small danger">{a.alertReason ?? a.squawk}</span>
                <span className="small">{fmtAlt(a.alt, p.units, a.onGround)}</span>
                <span className="small muted right">{a.type ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="small muted">7700 = general emergency · 7600 = radio failure · 7500 = hijack. Most emergencies are precautionary and end with a normal landing.</p>
      </section>
      <section className="card">
        <label className="toggle-row">
          <span>
            <b>🎖️ Show military aircraft layer</b>
            <span className="small muted block">Aircraft broadcasting publicly and flagged as military.</span>
          </span>
          <input type="checkbox" checked={p.showMilitary} onChange={p.onToggleMilitary} />
        </label>
        {p.showMilitary && (
          <ul className="board">
            {p.military === null && <div className="skeleton" style={{ height: 60 }} />}
            {p.military?.slice(0, 50).map((a) => (
              <li key={a.hex}>
                <button className="board-row" onClick={() => p.onSelect(a)}>
                  <b className="mono">{a.callsign ?? a.reg ?? a.hex.toUpperCase()}</b>
                  <span className="small muted">{a.type ?? ''}</span>
                  <span className="small">{fmtAlt(a.alt, p.units, a.onGround)}</span>
                  <span className="small muted right">{a.reg ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Filters

export const DEFAULT_FILTERS: Filters = {
  minAlt: 0,
  maxAlt: 50000,
  hideGround: false,
  query: '',
  kinds: { airliner: true, light: true, heli: true, military: true, other: true },
};

export function FiltersPanel(p: { filters: Filters; onChange: (f: Filters) => void; shown: number; total: number; units: Units; onClose: () => void }) {
  const f = p.filters;
  const set = (patch: Partial<Filters>) => p.onChange({ ...f, ...patch });
  const KINDS: [keyof Filters['kinds'], string][] = [
    ['airliner', '✈️ Airliners'],
    ['light', '🛩️ Light aircraft'],
    ['heli', '🚁 Helicopters'],
    ['military', '🎖️ Military'],
    ['other', '🎈 Gliders, balloons, drones & other'],
  ];
  const altLabel = (v: number) => (v >= 50000 ? 'max' : fmtAlt(v, p.units));
  return (
    <div className="panel-body">
      <Head title="Filters" sub={`Showing ${p.shown.toLocaleString()} of ${p.total.toLocaleString()} aircraft`} onClose={p.onClose} />
      <section className="card">
        <h3>Find in view</h3>
        <input className="input" placeholder="Callsign, type (A388), registration…" value={f.query} onChange={(e) => set({ query: e.target.value })} />
      </section>
      <section className="card">
        <h3>Altitude</h3>
        <div className="range-row">
          <span>{altLabel(f.minAlt)}</span>
          <span>→</span>
          <span>{altLabel(f.maxAlt)}</span>
        </div>
        <input type="range" min={0} max={50000} step={1000} value={f.minAlt} onChange={(e) => set({ minAlt: Math.min(Number(e.target.value), f.maxAlt) })} aria-label="Minimum altitude" />
        <input type="range" min={0} max={50000} step={1000} value={f.maxAlt} onChange={(e) => set({ maxAlt: Math.max(Number(e.target.value), f.minAlt) })} aria-label="Maximum altitude" />
        <label className="toggle-row">
          <span>Hide aircraft on the ground</span>
          <input type="checkbox" checked={f.hideGround} onChange={(e) => set({ hideGround: e.target.checked })} />
        </label>
      </section>
      <section className="card">
        <h3>Aircraft types</h3>
        {KINDS.map(([k, label]) => (
          <label key={k} className="toggle-row">
            <span>{label}</span>
            <input type="checkbox" checked={f.kinds[k]} onChange={(e) => set({ kinds: { ...f.kinds, [k]: e.target.checked } })} />
          </label>
        ))}
      </section>
      <button className="btn" onClick={() => p.onChange(DEFAULT_FILTERS)}>
        Reset filters
      </button>
      <p className="small muted">Emergencies are always shown, even when filtered out.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Settings

interface Health {
  status: string;
  degraded: string[];
  providers: Record<string, { name: string; state: string; lastError: string | null }[]>;
  airports: { count: number; source: string };
}

export function SettingsPanel(p: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onEnableNotifications: () => void;
  onToggleVoice: () => void;
  onClose: () => void;
}) {
  const s = p.settings;
  const set = (patch: Partial<Settings>) => p.onChange({ ...s, ...patch });
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setHealth)
      .catch(() => setHealthErr(true));
  }, []);

  return (
    <div className="panel-body">
      <Head title="Settings" onClose={p.onClose} />
      <section className="card">
        <h3>Units</h3>
        <div className="seg">
          {(
            [
              ['metric', 'Metric'],
              ['imperial', 'Imperial'],
              ['aviation', 'Aviation'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={s.units === k ? 'active' : ''} onClick={() => set({ units: k })}>
              {l}
            </button>
          ))}
        </div>
        <p className="small muted">Aviation uses feet, knots, nautical miles and flight levels.</p>
      </section>
      <section className="card">
        <h3>Map</h3>
        <div className="seg">
          {(['dark', 'light', 'satellite', 'terrain'] as const).map((k) => (
            <button key={k} className={s.mapStyle === k ? 'active' : ''} onClick={() => set({ mapStyle: k, theme: k === 'light' ? 'light' : k === 'dark' ? 'dark' : s.theme })}>
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <label className="toggle-row">
          <span>Interface theme</span>
          <select value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings['theme'] })} className="input small-input">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="toggle-row">
          <span>Show airports</span>
          <input type="checkbox" checked={s.showAirports} onChange={(e) => set({ showAirports: e.target.checked })} />
        </label>
        <label className="toggle-row">
          <span>
            Show estimated aircraft
            <span className="small muted block">Dashed planes: flights that recently left receiver coverage, moved forward along their route.</span>
          </span>
          <input type="checkbox" checked={s.showEstimated} onChange={(e) => set({ showEstimated: e.target.checked })} />
        </label>
        <label className="toggle-row">
          <span>Show flight trail for selected aircraft</span>
          <input type="checkbox" checked={s.showTrails} onChange={(e) => set({ showTrails: e.target.checked })} />
        </label>
      </section>
      <section className="card">
        <h3>Notifications</h3>
        <label className="toggle-row">
          <span>
            Voice announcements in “Above me”
            <span className="small muted block">Speaks when aircraft enter, turn, are about to leave, and leave your radar range.</span>
          </span>
          <input type="checkbox" checked={s.voice} onChange={p.onToggleVoice} />
        </label>
        <label className="toggle-row">
          <span>Browser alerts for My Flights</span>
          <input type="checkbox" checked={s.notifications} onChange={(e) => (e.target.checked ? p.onEnableNotifications() : set({ notifications: false }))} />
        </label>
      </section>
      <section className="card">
        <h3>Keyboard shortcuts</h3>
        <ul className="kbd-list small">
          <li>
            <kbd>/</kbd> Search
          </li>
          <li>
            <kbd>Esc</kbd> Close panel
          </li>
          <li>
            <kbd>M</kbd> My Flights
          </li>
          <li>
            <kbd>O</kbd> Above me
          </li>
          <li>
            <kbd>F</kbd> Filters
          </li>
          <li>
            <kbd>A</kbd> Alerts
          </li>
        </ul>
      </section>
      <section className="card">
        <h3>Data sources {health && <span className={`pill ${health.status === 'ok' ? 'live' : 'warn'}`}>{health.status}</span>}</h3>
        {healthErr && <p className="small danger">Can’t reach the data service right now.</p>}
        {health && (
          <ul className="providers small">
            {Object.entries(health.providers).map(([chain, list]) => (
              <li key={chain}>
                <span className="muted">{chain}</span>
                <span>
                  {list.map((pr) => (
                    <span key={pr.name} className={`prov ${pr.state}`} title={pr.lastError ?? 'healthy'}>
                      {pr.name}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">
          Live positions from the community ADS-B networks adsb.lol, adsb.fi and OpenSky; routes & aircraft from adsbdb and hexdb; photos from Planespotters; weather from Open-Meteo, MET Norway and aviationweather.gov; airports from OurAirports. If one source goes down we switch to the next one on its own.
        </p>
      </section>
    </div>
  );
}
