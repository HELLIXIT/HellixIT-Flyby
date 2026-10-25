'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Aircraft, AirportDetails, FlightDetails, FlightStatus, Units, WatchItem } from '@/lib/types';
import {
  PHASE_EMOJI,
  PHASE_LABEL,
  airportCode,
  airportLabel,
  compassWords,
  fmtAlt,
  fmtClock,
  fmtDist,
  fmtDuration,
  fmtSpeed,
  fmtTemp,
  fmtVrate,
  isEmergency,
  phaseOf,
  plainStatus,
  progressOf,
} from '@/lib/flight';
import Sparkline from './Sparkline';
import StatusCard from './StatusCard';

interface Props {
  hex: string;
  live: Aircraft | null;
  details: FlightDetails | null;
  detailsError: boolean;
  history: { t: number; alt: number | null; gs: number | null }[];
  units: Units;
  watch: WatchItem | undefined;
  onToggleWatch: () => void;
  /** FlightAware status source configured → offer schedule/gates/delays on demand. */
  statusEnabled: boolean;
  onSetTravel: (minutes: number | undefined) => void;
  onClose: () => void;
  onAirport: (code: string) => void;
  onLocate: () => void;
  onShare: () => void;
  /** Switch to the estimated-position view (signal lost, route known). */
  onEstimate: () => void;
}

const SQUAWK_TEXT: Record<string, string> = {
  '7700': 'The crew has declared an emergency. This often means a medical issue or technical problem and most end safely.',
  '7600': 'The aircraft has lost radio contact with air traffic control and is following standard procedures.',
  '7500': 'The aircraft is signalling unlawful interference.',
};

export default function FlightPanel(p: Props) {
  const { live, details, units } = p;
  const route = details?.route ?? null;
  const [dest, setDest] = useState<AirportDetails | null>(null);
  const [now, setNow] = useState(Date.now());
  const [photoOk, setPhotoOk] = useState(true);
  const [fa, setFa] = useState<FlightStatus | null | 'loading' | 'none'>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const destCode = route?.destination?.icao;
  useEffect(() => {
    setDest(null);
    if (!destCode) return;
    let cancelled = false;
    api
      .airport(destCode)
      .then((d) => !cancelled && setDest(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [destCode]);

  useEffect(() => {
    setPhotoOk(true);
    setFa(null);
  }, [p.hex]);

  const a = live ?? details?.live ?? null;
  const prog = useMemo(() => (a && route ? progressOf(a, route) : null), [a, route]);
  const phase = a ? phaseOf(a) : null;
  const flightNo = route?.callsignIata ?? a?.callsign ?? a?.reg ?? p.hex.toUpperCase();
  const lowConfidence = details?.routeConfidence === 'low';
  const eta = prog?.etaMinutes != null && !lowConfidence ? new Date(now + prog.etaMinutes * 60_000) : null;

  return (
    <div className="panel-body">
      <header className="fp-head">
        <div>
          <div className="fp-title">
            {flightNo}
            {route?.callsignIata && a?.callsign && <span className="muted small"> · {a.callsign}</span>}
          </div>
          <div className="muted">{route?.airline?.name ?? details?.aircraft?.owner ?? (a?.military ? 'Military' : 'Private / unknown operator')}</div>
        </div>
        <div className="fp-actions">
          <button className={`icon-btn ${p.watch ? 'on' : ''}`} onClick={p.onToggleWatch} title={p.watch ? 'Remove from My Flights' : 'Add to My Flights & get alerts'}>
            {p.watch ? '★' : '☆'}
          </button>
          <button className="icon-btn" onClick={p.onLocate} title="Center on map">
            ◎
          </button>
          <button className="icon-btn" onClick={p.onShare} title="Share this flight">
            ⤴
          </button>
          <button className="icon-btn" onClick={p.onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      {a && isEmergency(a) && (
        <div className="alert-box">
          <b>⚠️ Squawking {a.squawk}</b>
          <p>{SQUAWK_TEXT[a.squawk ?? ''] ?? 'The aircraft is reporting an emergency status.'}</p>
        </div>
      )}

      {details?.photo?.thumbnail && photoOk && (
        <a className="fp-photo" href={details.photo.link ?? undefined} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={details.photo.large ?? details.photo.thumbnail} alt={`${details.aircraft?.type ?? 'Aircraft'} ${a?.reg ?? ''}`} onError={() => setPhotoOk(false)} />
          {details.photo.photographer && <span className="credit">📷 {details.photo.photographer} · {details.photo.source}</span>}
        </a>
      )}

      {!a && !details && !p.detailsError && <div className="skeleton" style={{ height: 160 }} />}
      {!a && (details || p.detailsError) && (
        <div className="notice">
          This aircraft isn’t transmitting right now. It may have landed, be out of receiver range, or be parked. We’ll keep checking.
          {route?.origin && route.destination && (
            <div style={{ marginTop: 8 }}>
              <button className="btn small primary" onClick={p.onEstimate}>
                🗺️ Show estimated position
              </button>
            </div>
          )}
        </div>
      )}

      {route?.origin && route.destination && (
        <section className="card route">
          <div className="route-ends">
            <button className="route-end" onClick={() => p.onAirport(airportCode(route.origin))}>
              <span className="code-big">{airportCode(route.origin)}</span>
              <span className="muted">{airportLabel(route.origin)}</span>
            </button>
            <div className="route-mid muted small">{prog ? fmtDist(prog.totalNm, units) : ''}</div>
            <button className="route-end right" onClick={() => p.onAirport(airportCode(route.destination))}>
              <span className="code-big">{airportCode(route.destination)}</span>
              <span className="muted">{airportLabel(route.destination)}</span>
            </button>
          </div>
          {prog && (
            <>
              <div className="progress" aria-label={`${Math.round(prog.pct * 100)}% complete`}>
                <div className="progress-fill" style={{ width: `${prog.pct * 100}%` }} />
                <span className="progress-plane" style={{ left: `${prog.pct * 100}%` }}>
                  ✈
                </span>
              </div>
              <div className="route-foot small muted">
                <span>{fmtDist(prog.flownNm, units)} flown</span>
                <span>{fmtDist(prog.remainingNm, units)} to go</span>
              </div>
            </>
          )}
          {lowConfidence && <div className="warn small">Route data for this callsign may be out of date — the aircraft isn’t where we’d expect.</div>}
        </section>
      )}

      {a && phase && (
        <section className="card status">
          <span className={`phase phase-${phase}`}>
            {PHASE_EMOJI[phase]} {PHASE_LABEL[phase]}
          </span>
          <p className="status-text">{plainStatus(a, lowConfidence ? null : route, units)}</p>
          {eta && route?.destination && (
            <div className="eta-grid">
              <div>
                <span className="muted small">Estimated landing</span>
                <b>{fmtClock(eta, dest?.weather?.timezone, dest?.weather?.utcOffsetSeconds)}</b>
                <span className="muted small">local time in {airportLabel(route.destination)}</span>
              </div>
              <div>
                <span className="muted small">Your time</span>
                <b>{fmtClock(eta)}</b>
                <span className="muted small">in {fmtDuration(prog!.etaMinutes!)}</span>
              </div>
            </div>
          )}
        </section>
      )}

      {eta && route?.destination && route.origin && (
        <PickupAssistant
          eta={eta}
          now={now}
          international={route.origin.country !== route.destination.country}
          airportName={airportLabel(route.destination)}
          travelMinutes={p.watch?.travelMinutes}
          watched={!!p.watch}
          onSetTravel={p.onSetTravel}
        />
      )}

      {p.statusEnabled && (route?.callsign ?? a?.callsign) && (
        <section className="card">
          <h3>Schedule, gates & delays</h3>
          {fa === null && (
            <button
              className="btn small"
              onClick={() => {
                setFa('loading');
                api
                  .status((route?.callsign ?? a?.callsign)!)
                  .then((r) => setFa(r.status ?? 'none'))
                  .catch(() => setFa('none'));
              }}
            >
              Load schedule status
            </button>
          )}
          {fa === 'loading' && <div className="skeleton" style={{ height: 70 }} />}
          {fa === 'none' && <p className="small muted">No schedule data for this flight.</p>}
          {fa && typeof fa === 'object' && <StatusCard s={fa} />}
        </section>
      )}

      {a && (
        <section className="card">
          <h3>Live data</h3>
          <div className="stat-grid">
            <Stat label="Altitude" value={fmtAlt(a.alt, units, a.onGround)} />
            <Stat label="Ground speed" value={fmtSpeed(a.gs, units)} />
            <Stat label="Vertical speed" value={fmtVrate(a.vrate, units)} />
            <Stat label="Heading" value={a.track !== null ? `${Math.round(a.track)}° ${compassWords(a.track)}` : '—'} />
            <Stat label="Squawk" value={a.squawk ?? '—'} />
            <Stat label="Signal" value={`${a.source.toUpperCase()} · ${a.seen < 2 ? 'now' : `${Math.round(a.seen)}s ago`}`} />
          </div>
          <Sparkline label="Altitude" color="#818cf8" values={p.history.map((h) => h.alt ?? 0)} format={(v) => fmtAlt(v, units)} />
          <Sparkline label="Speed" color="#38bdf8" values={p.history.map((h) => h.gs ?? 0)} format={(v) => fmtSpeed(v, units)} />
        </section>
      )}

      {dest?.weather && route?.destination && (
        <section className="card">
          <h3>Weather at {airportLabel(route.destination)}</h3>
          <div className="wx">
            <span className="wx-icon">{dest.weather.icon}</span>
            <div>
              <b>
                {fmtTemp(dest.weather.tempC, units)} · {dest.weather.description}
              </b>
              <div className="muted small">
                Wind {dest.weather.windKt ?? '—'} kt{dest.weather.windDir != null ? ` from the ${compassWords(dest.weather.windDir)}` : ''}
                {dest.weather.gustKt && dest.weather.gustKt > (dest.weather.windKt ?? 0) + 8 ? `, gusts ${dest.weather.gustKt} kt` : ''}
              </div>
            </div>
          </div>
          {dest.metar && (
            <div className={`metar cat-${dest.metar.flightCategory ?? 'NA'}`}>
              <b>{dest.metar.flightCategory ?? 'Conditions'}</b> — {dest.metar.summary}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h3>Aircraft</h3>
        <div className="stat-grid">
          <Stat label="Type" value={details?.aircraft?.type ?? a?.desc ?? a?.type ?? '—'} />
          <Stat label="Manufacturer" value={details?.aircraft?.manufacturer ?? '—'} />
          <Stat label="Registration" value={details?.aircraft?.registration ?? a?.reg ?? '—'} />
          <Stat label="Mode-S hex" value={p.hex.toUpperCase()} />
          <Stat label="Operator" value={details?.aircraft?.owner ?? '—'} />
          <Stat label="Registered in" value={details?.aircraft?.ownerCountry ?? '—'} />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <b>{value}</b>
    </div>
  );
}

/**
 * "When should I leave to pick someone up?" — combines the live ETA with deplaning/customs
 * time and the user's travel time to the airport.
 */
function PickupAssistant(props: {
  eta: Date;
  now: number;
  international: boolean;
  airportName: string;
  travelMinutes: number | undefined;
  watched: boolean;
  onSetTravel: (m: number | undefined) => void;
}) {
  const [val, setVal] = useState(props.travelMinutes?.toString() ?? '');
  useEffect(() => setVal(props.travelMinutes?.toString() ?? ''), [props.travelMinutes]);
  const exitMin = props.international ? 40 : 20;
  const out = new Date(props.eta.getTime() + exitMin * 60_000);
  const travel = props.travelMinutes;
  const leave = travel != null ? new Date(out.getTime() - travel * 60_000) : null;
  const leaveIn = leave ? (leave.getTime() - props.now) / 60_000 : null;

  return (
    <section className="card pickup">
      <h3>🚗 Picking someone up?</h3>
      <p className="small muted">
        Passengers usually reach arrivals ~{exitMin} min after landing{props.international ? ' (includes passport control & bags)' : ''} — around{' '}
        <b>{fmtClock(out)}</b>.
      </p>
      <label className="pickup-row">
        <span>My travel time to {props.airportName}</span>
        <input
          type="number"
          min={0}
          max={600}
          inputMode="numeric"
          placeholder="min"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => props.onSetTravel(val === '' ? undefined : Math.max(0, Math.min(600, Number(val))))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      {leave && leaveIn !== null && (
        <div className={`leave ${leaveIn <= 0 ? 'now' : leaveIn < 20 ? 'soon' : ''}`}>
          {leaveIn <= 0 ? (
            <>
              Leave <b>now</b> — you’ll arrive about {fmtDuration(-leaveIn)} after they come out.
            </>
          ) : (
            <>
              Leave by <b>{fmtClock(leave)}</b> (in {fmtDuration(leaveIn)})
            </>
          )}
        </div>
      )}
      {travel != null && props.watched && <p className="small muted">Saved to My Flights — we’ll notify you when it’s time to leave.</p>}
    </section>
  );
}
