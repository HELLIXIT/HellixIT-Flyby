'use client';

import type { EstimatedPosition } from '@/lib/flight';
import { airportCode, airportLabel, fmtDuration } from '@/lib/flight';
import type { KnownFlight } from '@/lib/types';
import StatusCard from './StatusCard';

interface Props {
  flight: KnownFlight;
  estimate: EstimatedPosition | null;
  statusEnabled: boolean;
  watched: boolean;
  onWatch: () => void;
  onLocate: () => void;
  onAirport: (code: string) => void;
  onClose: () => void;
}

/** A real flight that no receiver can hear: schedule status + estimated position. */
export default function EstimatedPanel({ flight, estimate, statusEnabled, watched, onWatch, onLocate, onAirport, onClose }: Props) {
  const { route, status } = flight;
  const pct = estimate ? estimate.fraction : status?.progressPercent != null ? status.progressPercent / 100 : null;

  return (
    <div className="panel-body">
      <header className="fp-head">
        <div>
          <div className="fp-title">
            {flight.flightNumber}
            {flight.callsign !== flight.flightNumber && <span className="muted small"> · {flight.callsign}</span>}
          </div>
          <div className="muted">{route.airline?.name ?? 'Scheduled flight'}</div>
        </div>
        <div className="fp-actions">
          <button className={`icon-btn ${watched ? 'on' : ''}`} onClick={onWatch} title="Notify me when it's visible">
            {watched ? '★' : '☆'}
          </button>
          {estimate && (
            <button className="icon-btn" onClick={onLocate} title="Center on estimated position">
              ◎
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </header>

      <div className="notice">
        📡 <b>No live signal.</b>{' '}
        {estimate
          ? status?.source === 'estimate'
            ? 'No receiver can hear this aircraft right now. The dashed plane on the map is Flyby’s estimate, worked out from the last time a receiver saw it. It switches to the real position as soon as a receiver picks it up.'
            : 'No receiver can hear this aircraft right now, so the dashed plane on the map is an estimate from its takeoff and arrival times. It switches to the real position as soon as a receiver picks it up.'
          : status?.phase === 'scheduled'
            ? 'It hasn’t departed yet. It will appear live once it takes off within range of a receiver.'
            : 'No free receiver network can hear this flight right now. That’s common over oceans and remote regions.'}
      </div>

      <section className="card route">
        <div className="route-ends">
          <button className="route-end" onClick={() => onAirport(airportCode(route.origin))}>
            <span className="code-big">{airportCode(route.origin)}</span>
            <span className="muted">{airportLabel(route.origin)}</span>
          </button>
          <div className="route-mid muted small">{estimate ? `~${fmtDuration(estimate.minutesToGo)} to go` : ''}</div>
          <button className="route-end right" onClick={() => onAirport(airportCode(route.destination))}>
            <span className="code-big">{airportCode(route.destination)}</span>
            <span className="muted">{airportLabel(route.destination)}</span>
          </button>
        </div>
        {pct !== null && (
          <div className="progress estimated" aria-label={`about ${Math.round(pct * 100)}% complete`}>
            <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
            <span className="progress-plane" style={{ left: `${pct * 100}%` }}>
              ✈
            </span>
          </div>
        )}
      </section>

      {status ? (
        <section className="card">
          <h3>{status.source === 'estimate' ? 'Estimated status' : 'Flight status'}</h3>
          <StatusCard s={status} />
        </section>
      ) : (
        <section className="card">
          <h3>Flight status</h3>
          <p className="small muted">
            {statusEnabled
              ? 'The schedule source has no data for this flight right now.'
              : 'No receiver has seen this flight recently, so we can’t estimate where it is yet. We’ll keep checking. A FlightAware AeroAPI key (FLIGHTAWARE_AEROAPI_KEY) would add schedules, delays and gates.'}
          </p>
        </section>
      )}

      {!watched && (
        <button className="btn primary" onClick={onWatch}>
          🔔 Notify me when it’s visible
        </button>
      )}
    </div>
  );
}
