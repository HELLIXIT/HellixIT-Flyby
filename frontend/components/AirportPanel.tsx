'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Aircraft, AirportDetails, AirportTraffic, GroundFlight, Units } from '@/lib/types';
import { compassWords, fmtAlt, fmtClock, fmtDist, fmtTemp } from '@/lib/flight';

interface Props {
  code: string;
  units: Units;
  onClose: () => void;
  onSelect: (a: Aircraft) => void;
  onLocate: (lat: number, lon: number) => void;
  onShare: () => void;
}

type Tab = 'arrivals' | 'departures' | 'onGround';

export default function AirportPanel({ code, units, onClose, onSelect, onLocate, onShare }: Props) {
  const [info, setInfo] = useState<AirportDetails | null>(null);
  const [traffic, setTraffic] = useState<AirportTraffic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('arrivals');
  const [showRaw, setShowRaw] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [ground, setGround] = useState<{ scheduleEnabled: boolean; landed: GroundFlight[]; departing: GroundFlight[]; error?: string } | null>(null);
  const [groundLoading, setGroundLoading] = useState(false);

  useEffect(() => {
    setInfo(null);
    setTraffic(null);
    setError(null);
    setGround(null);
    let cancelled = false;
    api
      .airport(code)
      .then((d) => {
        if (cancelled) return;
        setInfo(d);
        onLocate(d.airport.lat, d.airport.lon);
      })
      .catch((e) => !cancelled && setError(e?.status === 404 ? 'We couldn’t find that airport.' : 'Airport info is temporarily unavailable.'));
    const loadTraffic = () =>
      api
        .airportTraffic(code)
        .then((t) => !cancelled && setTraffic(t))
        .catch(() => undefined);
    void loadTraffic();
    const t = setInterval(loadTraffic, 30_000);
    const c = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
      clearInterval(c);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // The schedule-based list costs FlightAware credit, so only load it when the tab is opened.
  useEffect(() => {
    if (tab !== 'onGround' || ground || groundLoading) return;
    setGroundLoading(true);
    api
      .airportGround(code)
      .then(setGround)
      .catch(() => setGround({ scheduleEnabled: false, landed: [], departing: [], error: 'unavailable' }))
      .finally(() => setGroundLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, code]);

  const ap = info?.airport;
  const wx = info?.weather;
  const list = traffic?.[tab] ?? [];

  return (
    <div className="panel-body">
      <header className="fp-head">
        <div>
          <div className="fp-title">{ap ? (ap.iata ?? ap.icao) : code.toUpperCase()}</div>
          <div className="muted">{ap ? ap.name : 'Loading…'}</div>
        </div>
        <div className="fp-actions">
          {ap && (
            <button className="icon-btn" onClick={() => onLocate(ap.lat, ap.lon)} title="Center on map">
              ◎
            </button>
          )}
          <button className="icon-btn" onClick={onShare} title="Share this airport">
            ⤴
          </button>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      {error && <div className="notice">{error}</div>}
      {!info && !error && <div className="skeleton" style={{ height: 120 }} />}

      {ap && (
        <section className="card">
          <div className="ap-meta">
            <div>
              <span className="muted small">Local time</span>
              <b className="big">{fmtClock(new Date(now), wx?.timezone, wx?.utcOffsetSeconds)}</b>
            </div>
            <div>
              <span className="muted small">Location</span>
              <b>{[ap.city, ap.countryName].filter(Boolean).join(', ')}</b>
            </div>
            <div>
              <span className="muted small">Codes</span>
              <b>
                {ap.iata ?? '—'} / {ap.icao}
              </b>
            </div>
          </div>
        </section>
      )}

      {wx && (
        <section className="card">
          <h3>Weather now</h3>
          <div className="wx">
            <span className="wx-icon">{wx.icon}</span>
            <div>
              <b>
                {fmtTemp(wx.tempC, units)} · {wx.description}
              </b>
              <div className="muted small">
                Wind {wx.windKt ?? '—'} kt{wx.windDir != null ? ` from the ${compassWords(wx.windDir)}` : ''}
                {wx.visibilityKm != null ? ` · visibility ${wx.visibilityKm} km` : ''}
              </div>
            </div>
          </div>
          {info?.metar && (
            <>
              <div className={`metar cat-${info.metar.flightCategory ?? 'NA'}`}>
                <b>{info.metar.flightCategory ?? 'Conditions'}</b> — {info.metar.summary}
              </div>
              <button className="link small" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? 'Hide' : 'Show'} raw METAR
              </button>
              {showRaw && <code className="raw">{info.metar.raw}</code>}
            </>
          )}
        </section>
      )}

      <section className="card">
        <h3>Live traffic board</h3>
        <p className="small muted">Built from real-time positions within 80 nm — no schedules needed, so it shows what’s actually happening.</p>
        <div className="tabs" role="tablist">
          {(
            [
              ['arrivals', '🛬 Arriving'],
              ['departures', '🛫 Departing'],
              ['onGround', '🅿️ At the airport'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {label}{' '}
              <span className="count">
                {k === 'onGround' && ground ? (traffic?.onGround.length ?? 0) + ground.landed.length + ground.departing.length : traffic ? traffic[k].length : '…'}
              </span>
            </button>
          ))}
        </div>
        {!traffic && <div className="skeleton" style={{ height: 100 }} />}
        {tab === 'onGround' && (
          <GroundLists
            ground={ground}
            loading={groundLoading}
            liveCount={traffic?.onGround.length ?? 0}
            tz={wx?.timezone ?? null}
            offset={wx?.utcOffsetSeconds}
          />
        )}
        {traffic && list.length === 0 && tab !== 'onGround' && <div className="muted small pad">Nothing right now.</div>}
        {tab === 'onGround' && traffic && list.length > 0 && <div className="sr-section">Heard by receivers on the ground</div>}
        <ul className="board">
          {list.slice(0, 40).map((a) => (
            <li key={a.hex}>
              <button className="board-row" onClick={() => onSelect(a)}>
                <b className="mono">{a.callsign ?? a.reg ?? a.hex.toUpperCase()}</b>
                <span className="muted small">{a.type ?? ''}</span>
                <span className="small">{fmtAlt(a.alt, units, a.onGround)}</span>
                <span className="small right">
                  {tab === 'arrivals' && a.etaMinutes != null ? `~${a.etaMinutes} min` : a.distanceNm != null ? fmtDist(a.distanceNm, units) : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function GroundLists(p: {
  ground: { scheduleEnabled: boolean; landed: GroundFlight[]; departing: GroundFlight[]; error?: string } | null;
  loading: boolean;
  liveCount: number;
  tz: string | null;
  offset?: number;
}) {
  if (p.loading || !p.ground) return <div className="skeleton" style={{ height: 80 }} />;
  const g = p.ground;
  const t = (iso: string | null) => (iso ? fmtClock(new Date(iso), p.tz, p.offset) : '—');
  if (!g.scheduleEnabled)
    return (
      <p className="small muted pad">
        {p.liveCount === 0 ? 'No receiver hears aircraft on the ground here. ' : ''}A FlightAware AeroAPI key (FLIGHTAWARE_AEROAPI_KEY) adds recently landed and departing-soon flights with gates.
      </p>
    );
  const row = (f: GroundFlight, kind: 'landed' | 'departing') => {
    const late = f.delayMin !== null && f.delayMin >= 15;
    return (
      <li key={`${kind}${f.ident}${f.time}`} className="ground-row">
        <b className="mono">{f.identIata ?? f.ident}</b>
        <span className="small">
          {kind === 'landed' ? 'from' : 'to'} {f.otherAirport?.code ?? '—'}
          <span className="muted"> {f.otherAirport?.city ?? ''}</span>
        </span>
        <span className="small right">
          {t(f.time)}
          {late && <span className="delay warn"> +{f.delayMin}m</span>}
        </span>
        <span className="small muted ground-meta">
          {[f.aircraftType, f.terminal && `T${f.terminal}`, f.gate && `Gate ${f.gate}`, f.baggage && `Bags ${f.baggage}`].filter(Boolean).join(' · ') || ' '}
        </span>
      </li>
    );
  };
  return (
    <>
      {g.error && <p className="small warn">Schedule list unavailable right now ({g.error}).</p>}
      <div className="sr-section">🛬 Landed in the last 2 h</div>
      {g.landed.length === 0 ? <p className="small muted pad">None.</p> : <ul className="board">{g.landed.map((f) => row(f, 'landed'))}</ul>}
      <div className="sr-section">🛫 Departing in the next 3 h</div>
      {g.departing.length === 0 ? <p className="small muted pad">None.</p> : <ul className="board">{g.departing.map((f) => row(f, 'departing'))}</ul>}
      <p className="small muted">From FlightAware schedules · local airport time. Exact parking positions need a receiver at the airport.</p>
    </>
  );
}
