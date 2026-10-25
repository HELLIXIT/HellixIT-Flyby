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

/** "On time" only within ±5 min — so the label never contradicts the times shown next to it. */
function delayText(min: number | null) {
  if (min === null) return null;
  if (min <= -5) return { text: `${fmtDuration(-min)} early`, tone: 'good' };
  if (min < 5) return { text: 'On time', tone: 'good' };
  return { text: `${fmtDuration(min)} late`, tone: min >= 45 ? 'bad' : min >= 15 ? 'warn' : 'mild' };
}

/** Minutes between the time shown and its scheduled counterpart (same kind: gate vs gate). */
function diffMin(shown: string | null | undefined, scheduled: string | null | undefined) {
  const a = Date.parse(shown ?? '');
  const b = Date.parse(scheduled ?? '');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 60_000) : null;
}

/** Departure/arrival times, delays and gates from the schedule source (FlightAware). */
export default function StatusCard({ s, compact = false }: { s: FlightStatus; compact?: boolean }) {
  const [icon, label] = s.landing && s.phase === 'airborne' ? ['🛬', 'Landing'] : PHASE[s.phase];
  const t = s.times;
  const est = s.source === 'estimate';
  const depTz = s.origin?.timezone;
  const arrTz = s.destination?.timezone;

  // Gate times (pushback / at the gate) are what passengers and airlines use; runway times
  // (take-off / landing) are only a fallback. Delays are computed from the times shown.
  const depGate = t.actualOut ?? t.estimatedOut ?? t.scheduledOut;
  const depIso = est ? t.actualOff : depGate ?? t.actualOff ?? t.estimatedOff ?? t.scheduledOff;
  const depIsGate = !est && !!depGate;
  const depLabel = est ? 'Took off ~' : t.actualOut || t.actualOff ? (depIsGate ? 'Left gate' : 'Took off') : 'Departs';
  const depTime = fmtLocal(depIso, depTz);
  const depSchedIso = depIsGate ? t.scheduledOut : t.scheduledOff ?? t.scheduledOut;
  const depSched = fmtLocal(depSchedIso, depTz);

  const arrGate = t.actualIn ?? t.estimatedIn ?? t.scheduledIn;
  const arrIso = est ? t.actualOn ?? t.estimatedOn : arrGate ?? t.actualOn ?? t.estimatedOn ?? t.scheduledOn;
  const arrIsGate = !est && !!arrGate;
  const arrLabel = est
    ? t.actualOn
      ? 'Landed ~'
      : 'Lands ~'
    : t.actualIn || t.actualOn
      ? arrIsGate
        ? 'At gate'
        : 'Landed'
      : arrIsGate
        ? 'At gate (est.)'
        : 'Lands (est.)';
  const arrTime = fmtLocal(arrIso, arrTz);
  const arrSchedIso = arrIsGate ? t.scheduledIn : t.scheduledOn ?? t.scheduledIn;
  const arrSched = fmtLocal(arrSchedIso, arrTz);

  const depDelay = delayText(diffMin(depIso, depSchedIso) ?? s.departureDelayMin);
  const arrDelay = delayText(diffMin(arrIso, arrSchedIso) ?? s.arrivalDelayMin);

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
