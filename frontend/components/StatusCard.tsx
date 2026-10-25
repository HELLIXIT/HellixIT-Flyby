'use client';

import type { FlightStatus } from '@/lib/types';
import { fmtDuration, fmtLocal } from '@/lib/flight';

const PHASE: Record<FlightStatus['phase'], [string, string]> = {
  scheduled: ['🕒', 'Scheduled'],
  taxiing: ['🛞', 'Taxiing'],
  airborne: ['✈️', 'In the air'],
  landed: ['🛬', 'Landed'],
  arrived: ['✅', 'Arrived'],
  cancelled: ['⛔', 'Cancelled'],
  diverted: ['↪️', 'Diverted'],
};

function delayText(min: number | null) {
  if (min === null) return null;
  if (min <= -5) return { text: `${fmtDuration(-min)} early`, tone: 'good' };
  if (min < 15) return { text: 'On time', tone: 'good' };
  return { text: `${fmtDuration(min)} late`, tone: min >= 45 ? 'bad' : 'warn' };
}

/** Departure/arrival times, delays and gates from the schedule source (FlightAware). */
export default function StatusCard({ s, compact = false }: { s: FlightStatus; compact?: boolean }) {
  const [icon, label] = PHASE[s.phase];
  const t = s.times;
  const est = s.source === 'estimate';
  const depTz = s.origin?.timezone;
  const arrTz = s.destination?.timezone;

  // Gate times (out/in) are what passengers see; runway times (off/on) are the fallback.
  const depActual = t.actualOut ?? t.actualOff;
  const depLabel = est ? 'Took off ~' : depActual ? 'Departed' : 'Departs';
  const depTime = fmtLocal(depActual ?? t.estimatedOut ?? t.estimatedOff ?? t.scheduledOut ?? t.scheduledOff, depTz);
  const depSched = fmtLocal(t.scheduledOut ?? t.scheduledOff, depTz);

  const arrActual = t.actualIn ?? t.actualOn;
  const arrLabel = est ? (arrActual ? 'Landed ~' : 'Lands ~') : arrActual ? 'Arrived' : 'Arrives';
  const arrTime = fmtLocal(arrActual ?? t.estimatedIn ?? t.estimatedOn ?? t.scheduledIn ?? t.scheduledOn, arrTz);
  const arrSched = fmtLocal(t.scheduledIn ?? t.scheduledOn, arrTz);

  const depDelay = delayText(s.departureDelayMin);
  const arrDelay = delayText(s.arrivalDelayMin);

  return (
    <div className={`fa-status ${compact ? 'compact' : ''}`}>
      <div className="fa-head">
        <span className={`phase fa-phase-${s.phase}`}>
          {icon} {label}
        </span>
        {s.status && <span className="small muted">{s.status}</span>}
      </div>
      {s.progressPercent !== null && s.phase === 'airborne' && (
        <div className="progress slim" aria-label={`${s.progressPercent}% complete`}>
          <div className="progress-fill" style={{ width: `${s.progressPercent}%` }} />
        </div>
      )}
      <div className="fa-times">
        <div>
          <span className="muted small">
            {depLabel} {s.origin?.iata ?? s.origin?.icao ?? ''}
          </span>
          <b>{depTime ?? '—'}</b>
          {depSched && depSched !== depTime && <s className="muted small">{depSched}</s>}
          {depDelay && <span className={`delay ${depDelay.tone}`}>{depDelay.text}</span>}
          {!compact && (s.terminalOrigin || s.gateOrigin) && (
            <span className="small muted">
              {[s.terminalOrigin && `Terminal ${s.terminalOrigin}`, s.gateOrigin && `Gate ${s.gateOrigin}`].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <div>
          <span className="muted small">
            {arrLabel} {s.destination?.iata ?? s.destination?.icao ?? ''}
          </span>
          <b>{arrTime ?? '—'}</b>
          {arrSched && arrSched !== arrTime && <s className="muted small">{arrSched}</s>}
          {arrDelay && <span className={`delay ${arrDelay.tone}`}>{arrDelay.text}</span>}
          {!compact && (s.terminalDestination || s.gateDestination || s.baggageClaim) && (
            <span className="small muted">
              {[s.terminalDestination && `Terminal ${s.terminalDestination}`, s.gateDestination && `Gate ${s.gateDestination}`, s.baggageClaim && `Bags ${s.baggageClaim}`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
      </div>
      {est && s.basis && <div className="small muted">Based on: {s.basis}.</div>}
      <div className="fa-credit small muted">
        {est ? 'Estimated by Flyby from the last radar contact · times in your time zone · may be off by 10–30 min' : 'Local airport times · schedule data by FlightAware'}
      </div>
    </div>
  );
}
