'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Aircraft, Airport, KnownFlight, Units } from '@/lib/types';
import { airportCode, airportLabel, fmtAlt } from '@/lib/flight';
import StatusCard from './StatusCard';

const NO_SIGNAL_LABEL: Record<string, string> = {
  scheduled: 'SCHEDULED',
  taxiing: 'TAXIING',
  airborne: 'ESTIMATED',
  landed: 'LANDED',
  arrived: 'ARRIVED',
  cancelled: 'CANCELLED',
  diverted: 'DIVERTED',
};

interface Props {
  units: Units;
  recent: string[];
  onFlight: (a: Aircraft) => void;
  onAirport: (a: Airport) => void;
  onRecent: (q: string) => void;
  /** Watch a flight that exists but isn't in receiver coverage yet. */
  onWatchKnown: (f: KnownFlight) => void;
  /** Open the details panel (schedule status + estimated position) for a no-signal flight. */
  onShowKnown: (f: KnownFlight) => void;
}

type Result = { kind: 'flight'; a: Aircraft } | { kind: 'airport'; a: Airport };

const SearchBox = forwardRef<HTMLInputElement, Props>(function SearchBox({ units, recent, onFlight, onAirport, onRecent, onWatchKnown, onShowKnown }, ref) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [resolved, setResolved] = useState<string | null>(null);
  const [known, setKnown] = useState<KnownFlight | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  // Enter pressed before results arrived → pick the first result as soon as they do.
  const pendingEnter = useRef(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setResolved(null);
      setKnown(null);
      return;
    }
    const t = setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError(false);
      try {
        const r = await api.search(term, c.signal);
        const list: Result[] = [...r.flights.map((a) => ({ kind: 'flight' as const, a })), ...r.airports.map((a) => ({ kind: 'airport' as const, a }))];
        setResults(list);
        setKnown(r.knownFlight ?? null);
        if (pendingEnter.current && list[0]) {
          pendingEnter.current = false;
          pick(list[0]);
          return;
        }
        setResolved(r.resolvedCallsign && r.resolvedCallsign !== term.toUpperCase().replace(/\s/g, '') ? r.resolvedCallsign : null);
        setActive(0);
      } catch {
        if (!c.signal.aborted) setError(true);
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (r: Result) => {
    if (r.kind === 'flight') onFlight(r.a);
    else onAirport(r.a);
    onRecent(q.trim());
    setOpen(false);
    setQ('');
  };

  const showRecent = open && q.trim().length < 2 && recent.length > 0;

  return (
    <div className="search" role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <span className="search-icon" aria-hidden>
        ⌕
      </span>
      <input
        ref={ref}
        value={q}
        placeholder="Flight (BA123), airport, registration…"
        aria-label="Search flights and airports"
        onChange={(e) => {
          pendingEnter.current = false;
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((i) => Math.min(results.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter') {
            if (results[active] && !loading) pick(results[active]);
            else if (q.trim().length >= 2) pendingEnter.current = true;
          }
          else if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {loading && <span className="spinner" aria-label="Searching" />}
      {kbdHint(q)}
      {open && (results.length > 0 || showRecent || (q.trim().length >= 2 && !loading)) && (
        <div className="search-results" role="listbox">
          {showRecent && (
            <>
              <div className="sr-section">Recent searches</div>
              {recent.map((r) => (
                <button key={r} className="sr-item" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ(r)}>
                  <span className="sr-icon">🕘</span>
                  <span className="sr-main">{r}</span>
                </button>
              ))}
            </>
          )}
          {resolved && <div className="sr-note">Searching as broadcast callsign {resolved}</div>}
          {known && (
            <div className="sr-known">
              <div className="sr-known-head">
                <span className="sr-icon">🛰️</span>
                <span className="sr-main">
                  <b>
                    {known.flightNumber} · {known.route.airline?.name ?? known.callsign}
                  </b>
                  <small>
                    {airportLabel(known.route.origin)} ({airportCode(known.route.origin)}) → {airportLabel(known.route.destination)} ({airportCode(known.route.destination)})
                  </small>
                </span>
                <span className="pill warn">{known.status ? NO_SIGNAL_LABEL[known.status.phase] : 'NO SIGNAL'}</span>
              </div>
              {known.status && <StatusCard s={known.status} compact />}
              <p className="small muted">
                {known.status?.phase === 'scheduled'
                  ? 'Not departed yet — it will appear on the map once it takes off within range of a receiver.'
                  : known.status?.phase === 'airborne'
                    ? known.status.source === 'estimate'
                      ? 'No receiver can hear it right now (common over oceans and remote regions). We estimated its position from the last time a receiver saw it.'
                      : 'No receiver can hear it right now (common over oceans and remote regions), so we estimate its position from the schedule.'
                    : known.status
                      ? 'This flight is not transmitting right now.'
                      : "This flight exists, but no free receiver network can hear it right now. That's common over oceans, deserts and parts of Asia and Africa, or before departure. It shows up as soon as a receiver picks it up."}
              </p>
              <div className="sr-known-actions">
                <button
                  className="btn small"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onShowKnown(known);
                    onRecent(q.trim());
                    setOpen(false);
                    setQ('');
                  }}
                >
                  {known.status?.phase === 'airborne' ? '🗺️ Show estimated position' : '🗺️ View flight'}
                </button>
                <button
                  className="btn small primary"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onWatchKnown(known);
                    onRecent(q.trim());
                    setOpen(false);
                    setQ('');
                  }}
                >
                🔔 Notify me when it's visible
                </button>
              </div>
            </div>
          )}
          {results.some((r) => r.kind === 'flight') && <div className="sr-section">Live flights</div>}
          {results.map((r, i) =>
            r.kind === 'flight' ? (
              <button
                key={`f${r.a.hex}`}
                className={`sr-item ${i === active ? 'active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                role="option"
                aria-selected={i === active}
              >
                <span className="sr-icon">✈️</span>
                <span className="sr-main">
                  <b>{r.a.callsign ?? r.a.reg ?? r.a.hex.toUpperCase()}</b>
                  <small>
                    {[r.a.type, r.a.reg].filter(Boolean).join(' · ')} — {fmtAlt(r.a.alt, units, r.a.onGround)}
                  </small>
                </span>
                <span className="pill live">LIVE</span>
              </button>
            ) : null,
          )}
          {results.some((r) => r.kind === 'airport') && <div className="sr-section">Airports</div>}
          {results.map((r, i) =>
            r.kind === 'airport' ? (
              <button
                key={`a${r.a.icao}`}
                className={`sr-item ${i === active ? 'active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                role="option"
                aria-selected={i === active}
              >
                <span className="sr-icon">🛬</span>
                <span className="sr-main">
                  <b>{r.a.name}</b>
                  <small>{[r.a.city, r.a.countryName].filter(Boolean).join(', ')}</small>
                </span>
                <span className="code">{r.a.iata ?? r.a.icao}</span>
              </button>
            ) : null,
          )}
          {q.trim().length >= 2 && !loading && results.length === 0 && !known && (
            <div className="sr-empty">
              {error ? 'Search is temporarily unavailable — retrying shortly.' : 'No live flight or airport matches. Flights only appear while airborne or transmitting.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function kbdHint(q: string) {
  return q ? null : (
    <kbd className="kbd" aria-hidden>
      /
    </kbd>
  );
}

export default SearchBox;
