'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { usePersistentState } from '@/lib/storage';
import type { Aircraft, Airport, EstimatedAircraft, MapAirport, Filters, FlightDetails, FlightStatus, KnownFlight, Settings, WatchItem } from '@/lib/types';
import EstimatedPanel from './EstimatedPanel';
import { AircraftMerger } from '@/lib/merge';
import { toTargets, useRadarVoice } from '@/lib/radarVoice';
import { airportCode as codeOf, distanceNm, estimatePosition, airportLabel, fmtAlt, fmtClock, fmtSpeed, isEmergency, passesFilters, phaseOf, progressOf, type Phase } from '@/lib/flight';
import MapView, { type MapHandle, type ViewBounds } from './MapView';
import SearchBox from './SearchBox';
import FlightPanel from './FlightPanel';
import AirportPanel from './AirportPanel';
import OverheadPanel from './OverheadPanel';
import { AlertsPanel, DEFAULT_FILTERS, FiltersPanel, SettingsPanel, WatchlistPanel } from './Panels';

type PanelKind = 'flight' | 'airport' | 'overhead' | 'watchlist' | 'alerts' | 'filters' | 'settings' | 'estimated';
type Conn = 'connecting' | 'waking' | 'live' | 'degraded' | 'offline';

const DEFAULT_SETTINGS: Settings = {
  units: 'metric',
  mapStyle: 'dark',
  theme: 'dark',
  showTrails: true,
  showEstimated: true,
  voice: false,
  showAirports: true,
  notifications: false,
};

interface TrailPoint {
  t: number;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
}

interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'warn' | 'good';
  hex?: string;
}

/** First view: last session → URL → rough region from the browser's timezone. */
function initialView() {
  try {
    const saved = JSON.parse(localStorage.getItem('flyby.view') ?? 'null');
    if (saved && Number.isFinite(saved.lat)) return saved as { lat: number; lon: number; zoom: number };
  } catch {
    /* ignore */
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  if (tz.startsWith('America/')) return { lat: 39, lon: -96, zoom: 5 };
  if (tz.startsWith('Europe/')) return { lat: 50, lon: 8, zoom: 5 };
  if (tz.startsWith('Asia/Kolkata') || tz.startsWith('Asia/Colombo')) return { lat: 15, lon: 79, zoom: 5 };
  if (tz.startsWith('Asia/')) return { lat: 28, lon: 105, zoom: 4 };
  if (tz.startsWith('Australia/')) return { lat: -28, lon: 140, zoom: 4 };
  if (tz.startsWith('Africa/')) return { lat: 5, lon: 20, zoom: 4 };
  return { lat: 45, lon: 0, zoom: 4 };
}

/**
 * Express a layer estimate as a schedule-style status: take-off/landing times chosen so that
 * interpolating along the route puts the plane exactly where the layer shows it now.
 */
function statusFromEstimate(e: EstimatedAircraft): FlightStatus | null {
  if (!e.origin || !e.destination || e.etaMinutes == null) return null;
  const now = Date.now();
  const flown = distanceNm(e.origin.lat, e.origin.lon, e.lat, e.lon);
  const left = distanceNm(e.lat, e.lon, e.destination.lat, e.destination.lon);
  const f = Math.min(0.98, flown / (flown + left || 1));
  const arr = now + e.etaMinutes * 60_000;
  const dep = now - (f * (arr - now)) / (1 - f);
  const ap = (a: Airport) => ({ icao: a.icao, iata: a.iata, name: a.name, city: a.city, timezone: null });
  const mins = Math.round(e.silentSec / 60);
  const t = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    source: 'estimate',
    basis:
      e.method === 'departure'
        ? `took off from ${e.origin.iata ?? e.origin.icao}, signal lost ${mins} min ago (OpenSky)`
        : e.method === 'flightaware'
          ? `position from ${e.lastSeenSource} ${mins} min ago`
          : e.method === 'schedule'
          ? `its schedule (${e.lastSeenSource}) — no receiver has heard it`
          : `last heard ${mins} min ago by ${e.lastSeenSource}`,
    hex: e.hex,
    ident: e.callsign,
    identIata: e.flightNumber,
    status: 'Estimated — no live signal',
    phase: 'airborne',
    cancelled: false,
    diverted: false,
    progressPercent: Math.round(f * 100),
    origin: ap(e.origin),
    destination: ap(e.destination),
    aircraftType: e.type,
    registration: e.reg,
    departureDelayMin: null,
    arrivalDelayMin: null,
    gateOrigin: null,
    gateDestination: null,
    terminalOrigin: null,
    terminalDestination: null,
    baggageClaim: null,
    times: {
      scheduledOut: null, estimatedOut: null, actualOut: null,
      scheduledOff: null, estimatedOff: null, actualOff: t(dep),
      scheduledOn: null, estimatedOn: t(arr), actualOn: null,
      scheduledIn: null, estimatedIn: null, actualIn: null,
    },
    fetchedAt: new Date(now).toISOString(),
  };
}

function notify(title: string, body: string) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.svg', tag: `${title}${body}` });
    }
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}

export default function FlybyApp() {
  const [settings, setSettings] = usePersistentState<Settings>('flyby.settings', DEFAULT_SETTINGS);
  const [filters, setFilters] = usePersistentState<Filters>('flyby.filters', DEFAULT_FILTERS);
  const [watchlist, setWatchlist] = usePersistentState<WatchItem[]>('flyby.watch', []);
  const [recent, setRecent] = usePersistentState<string[]>('flyby.recent', []);
  const [view] = useState(initialView);

  const mapRef = useRef<MapHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [bounds, setBounds] = useState<ViewBounds | null>(null);
  const [area, setArea] = useState<{ aircraft: Aircraft[]; receivedAt: number; source: string; truncated: boolean }>({
    aircraft: [],
    receivedAt: Date.now(),
    source: '',
    truncated: false,
  });
  const [conn, setConn] = useState<Conn>('connecting');

  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const selectedHexRef = useRef<string | null>(null);
  useEffect(() => {
    selectedHexRef.current = selectedHex;
  }, [selectedHex]);
  const [selectedLive, setSelectedLive] = useState<Aircraft | null>(null);
  const [details, setDetails] = useState<FlightDetails | null>(null);
  const [detailsError, setDetailsError] = useState(false);
  const [airportCode, setAirportCode] = useState<string | null>(null);

  const trails = useRef(new Map<string, TrailPoint[]>());
  // Merges partial/out-of-order reports from different networks per aircraft.
  const merger = useRef(new AircraftMerger());
  const [trailVersion, setTrailVersion] = useState(0);

  const [userLoc, setUserLoc] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [overheadRadius, setOverheadRadius] = useState(25);

  const [alerts, setAlerts] = useState<Aircraft[] | null>(null);
  const [military, setMilitary] = useState<Aircraft[] | null>(null);
  const [showMilitary, setShowMilitary] = useState(false);
  const [watchLive, setWatchLive] = useState<Record<string, Aircraft | null | undefined>>({});
  const [mapAirports, setMapAirports] = useState<MapAirport[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [cartoKey, setCartoKey] = useState<string | null>(null);
  const [statusEnabled, setStatusEnabled] = useState(false);
  // A real flight that no receiver can hear (opened from search): schedule status + estimate.
  const [known, setKnown] = useState<KnownFlight | null>(null);
  const [estimateTick, setEstimateTick] = useState(0);
  // Estimated-aircraft layer (flights that recently left receiver coverage).
  const [estimatedList, setEstimatedList] = useState<EstimatedAircraft[]>([]);

  // ---------------------------------------------------------------- helpers

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info', hex?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone, hex }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  const recordTrail = useCallback((a: Aircraft) => {
    const list = trails.current.get(a.hex) ?? [];
    const last = list[list.length - 1];
    if (last && last.lat === a.lat && last.lon === a.lon) return false;
    list.push({ t: Date.now(), lat: a.lat, lon: a.lon, alt: a.onGround ? 0 : a.alt, gs: a.gs });
    if (list.length > 720) list.splice(0, list.length - 720);
    trails.current.set(a.hex, list);
    return true;
  }, []);

  const setUrl = useCallback((params: Record<string, string | null>) => {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v) u.searchParams.set(k, v);
      else u.searchParams.delete(k);
    }
    window.history.replaceState(null, '', u.toString());
  }, []);

  // ---------------------------------------------------------------- theme
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // ---------------------------------------------------------------- live area polling (with backoff)
  useEffect(() => {
    if (!bounds) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    let ctrl: AbortController | null = null;

    const tick = async () => {
      ctrl = new AbortController();
      // A free-tier backend that was asleep takes a while to answer — tell the user why.
      const wake = setTimeout(() => setConn((c) => (c === 'live' || c === 'degraded' ? c : 'waking')), 4000);
      try {
        const r = await api.bounds(bounds, ctrl.signal);
        if (stopped) return;
        failures = 0;
        const now = Date.now();
        setArea({ aircraft: merger.current.merge(r.aircraft, now), receivedAt: now, source: r.source, truncated: r.truncated });
        setConn(r.degraded ? 'degraded' : 'live');
      } catch {
        if (stopped) return;
        failures++;
        // Keep showing the last known positions; just flag the connection state.
        setConn(failures >= 2 ? 'offline' : 'degraded');
      } finally {
        clearTimeout(wake);
      }
      if (stopped) return;
      // Wide views come from a world snapshot the server refreshes every 15 s.
      const wide = bounds.e - bounds.w > 30 || bounds.n - bounds.s > 25;
      const base = document.hidden ? 30_000 : wide ? 15_000 : 6_000;
      timer = setTimeout(tick, failures ? Math.min(60_000, base * 2 ** failures) : base);
    };
    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl?.abort();
    };
  }, [bounds]);

  // Estimated aircraft for the viewport: refreshed every 30 s (they move slowly and the server
  // only learns about new ones every couple of minutes).
  useEffect(() => {
    if (!bounds || !settings.showEstimated) {
      setEstimatedList([]);
      return;
    }
    let stopped = false;
    const load = () =>
      api
        .estimated(bounds)
        .then((r) => !stopped && setEstimatedList(r.aircraft))
        .catch(() => undefined);
    const first = setTimeout(load, 800);
    const t = setInterval(load, 30_000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [bounds, settings.showEstimated]);

  // Remember the map view for next visit.
  useEffect(() => {
    if (!bounds) return;
    const c = mapRef.current?.getCenter();
    if (c) localStorage.setItem('flyby.view', JSON.stringify({ lat: c.lat, lon: c.lon, zoom: c.zoom }));
  }, [bounds]);

  // ---------------------------------------------------------------- selected flight
  const inArea = selectedHex ? area.aircraft.find((a) => a.hex === selectedHex) ?? null : null;
  const selected = inArea ?? (selectedLive?.hex === selectedHex ? selectedLive : null);

  // Poll the selected aircraft directly when it's outside the current view.
  useEffect(() => {
    if (!selectedHex || inArea) return;
    let stopped = false;
    const load = async () => {
      try {
        const r = await api.flight(selectedHex);
        if (!stopped) setSelectedLive(r.aircraft ? merger.current.one(r.aircraft) : null);
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = setInterval(load, 6_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [selectedHex, !!inArea]);

  // Route/aircraft/photo details (slow-changing).
  const selCallsign = selected?.callsign ?? null;
  useEffect(() => {
    if (!selectedHex) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let thin = 0;
    setDetailsError(false);
    const load = async () => {
      let delay = 120_000;
      try {
        const d = await api.details(selectedHex, selCallsign);
        if (stopped) return;
        failures = 0;
        setDetailsError(false);
        // Keep what we already know if a refresh comes back thinner (e.g. callsign briefly missing).
        setDetails((prev) =>
          prev
            ? {
                ...d,
                route: d.route ?? prev.route,
                routeConfidence: d.route ? d.routeConfidence : prev.routeConfidence,
                aircraft: d.aircraft ?? prev.aircraft,
                photo: d.photo ?? prev.photo,
              }
            : d,
        );
        // Incomplete answer (a source hiccup)? Try again soon, a few times.
        if ((!d.route && selCallsign) || !d.aircraft) delay = ++thin <= 4 ? 20_000 : 120_000;
      } catch {
        if (stopped) return;
        setDetailsError(true);
        // Backend restarting / waking up / network blip: retry quickly with backoff.
        delay = [3_000, 8_000, 20_000, 45_000][failures++] ?? 120_000;
      }
      if (!stopped) timer = setTimeout(load, delay);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selectedHex, selCallsign]);

  // Trail history for selected + watched aircraft.
  useEffect(() => {
    let changed = false;
    const keep = new Set([selectedHex, ...watchlist.map((w) => w.hex)].filter(Boolean) as string[]);
    for (const a of area.aircraft) if (keep.has(a.hex)) changed = recordTrail(a) || changed;
    if (selectedLive && keep.has(selectedLive.hex)) changed = recordTrail(selectedLive) || changed;
    if (changed) setTrailVersion((v) => v + 1);
  }, [area, selectedLive, selectedHex, watchlist, recordTrail]);

  const selectFlight = useCallback(
    (hex: string | null, a?: Aircraft | null, fly = false) => {
      // Re-selecting the current flight (e.g. clicking its plane again) must keep its details:
      // the details effect is keyed on the hex, so it would not refetch what we'd clear here.
      const same = hex !== null && hex === selectedHexRef.current;
      selectedHexRef.current = hex;
      setSelectedHex(hex);
      if (!same) {
        setDetails(null);
        setSelectedLive(a ?? null);
      }
      if (hex) {
        setPanel('flight');
        setAirportCode(null);
        setUrl({ flight: hex, airport: null });
        if (a) recordTrail(a);
        if (fly && a) mapRef.current?.flyTo(a.lat, a.lon);
      } else {
        setPanel((p) => (p === 'flight' ? null : p));
        setUrl({ flight: null });
      }
    },
    [setUrl, recordTrail],
  );

  const openAirport = useCallback(
    (code: string) => {
      setAirportCode(code);
      setSelectedHex(null);
      setPanel('airport');
      setUrl({ airport: code, flight: null });
    },
    [setUrl],
  );

  // Deep links: ?flight=hex or ?airport=LHR
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const hex = q.get('flight');
    const ap = q.get('airport');
    if (hex && /^~?[0-9a-f]{6}$/i.test(hex)) {
      setSelectedHex(hex.toLowerCase());
      setPanel('flight');
      api
        .flight(hex)
        .then((r) => {
          if (r.aircraft) {
            setSelectedLive(r.aircraft);
            mapRef.current?.flyTo(r.aircraft.lat, r.aircraft.lon, 8);
          }
        })
        .catch(() => undefined);
    } else if (ap) openAirport(ap);
    api
      .config()
      .then((c) => {
        setCartoKey(c.cartoApiKey);
        setStatusEnabled(c.flightStatusEnabled);
      })
      .catch(() => undefined);
    api
      .mapAirports()
      .then(setMapAirports)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- alerts & military
  useEffect(() => {
    const load = () =>
      api
        .alerts()
        .then((r) => setAlerts(r.aircraft))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, panel === 'alerts' ? 30_000 : 90_000);
    return () => clearInterval(t);
  }, [panel === 'alerts']);

  useEffect(() => {
    if (!showMilitary) return;
    const load = () =>
      api
        .military()
        .then((r) => setMilitary(r.aircraft))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [showMilitary]);

  // ---------------------------------------------------------------- watchlist monitor + notifications
  const watchState = useRef(new Map<string, { phase: Phase | 'gone'; onGround: boolean; emergency: boolean; leaveNotified: boolean; descentNotified: boolean }>());
  const watchRoutes = useRef(new Map<string, FlightDetails['route']>());
  const watchRef = useRef(watchlist);
  watchRef.current = watchlist;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      for (const w of watchRef.current) {
        if (stopped) return;
        // Flight saved from search while out of coverage: look for its callsign on every network.
        if (w.hex.startsWith('cs:')) {
          let found: Aircraft | null;
          try {
            found = (await api.byCallsign(w.hex.slice(3))).aircraft;
            if (found) found = merger.current.one(found);
          } catch {
            continue;
          }
          if (!found) {
            setWatchLive((m) => ({ ...m, [w.hex]: null }));
            // Keeps the server's schedule/estimate fresh, so the flight shows on the estimated layer.
            void api.status(w.hex.slice(3)).catch(() => undefined);
            continue;
          }
          const f = found;
          setWatchlist((l) =>
            l.some((x) => x.hex === f.hex) ? l.filter((x) => x.hex !== w.hex) : l.map((x) => (x.hex === w.hex ? { ...x, hex: f.hex, callsign: f.callsign } : x)),
          );
          setWatchLive((m) => ({ ...m, [f.hex]: f }));
          recordTrail(f);
          toast(`📡 ${w.label} is now visible — tap to see it on the map.`, 'good', f.hex);
          if (settingsRef.current.notifications) notify(`📡 ${w.label} is now visible`, w.routeLabel ?? 'Tap to track it live.');
          continue;
        }
        let a: Aircraft | null;
        try {
          a = (await api.flight(w.hex)).aircraft;
          if (a) a = merger.current.one(a);
        } catch {
          continue; // network hiccup — don't emit false "lost signal" events
        }
        setWatchLive((m) => ({ ...m, [w.hex]: a }));
        if (a) recordTrail(a);
        if (!watchRoutes.current.has(w.hex) && a?.callsign) {
          api
            .details(w.hex, a.callsign)
            .then((d) => watchRoutes.current.set(w.hex, d.route))
            .catch(() => undefined);
        }
        const prev = watchState.current.get(w.hex);
        const phase: Phase | 'gone' = a ? phaseOf(a) : 'gone';
        const emergency = a ? isEmergency(a) : false;
        const onGround = a ? a.onGround : prev?.onGround ?? true;
        const route = watchRoutes.current.get(w.hex) ?? null;
        const destName = route?.destination ? airportLabel(route.destination) : null;
        const say = (title: string, body: string, tone: Toast['tone'] = 'info') => {
          toast(`${title} — ${body}`, tone, w.hex);
          if (settingsRef.current.notifications) notify(title, body);
        };
        const next = { phase, onGround, emergency, leaveNotified: prev?.leaveNotified ?? false, descentNotified: prev?.descentNotified ?? false };

        if (prev && a) {
          if (prev.onGround && !a.onGround && (a.vrate ?? 0) > 0) say(`🛫 ${w.label} took off`, destName ? `On the way to ${destName}.` : 'Now airborne.', 'good');
          if (!prev.onGround && a.onGround) say(`🛬 ${w.label} landed`, destName ? `Welcome to ${destName}!` : 'Now on the ground.', 'good');
          if (!prev.descentNotified && phase === 'descent' && (a.alt ?? 0) > 12000) {
            next.descentNotified = true;
            const prog = progressOf(a, route);
            say(`↘️ ${w.label} started descending`, prog?.etaMinutes ? `Landing in about ${Math.round(prog.etaMinutes)} min.` : 'Landing soon.');
          }
          if (!prev.emergency && emergency) say(`⚠️ ${w.label} squawking ${a.squawk}`, 'The crew is reporting an emergency.', 'warn');
        }
        // Pickup assistant: time to leave?
        if (a && w.travelMinutes != null && route?.destination && route.origin && !next.leaveNotified) {
          const prog = progressOf(a, route);
          if (prog?.etaMinutes != null) {
            const exit = route.origin.country !== route.destination.country ? 40 : 20;
            const leaveIn = prog.etaMinutes + exit - w.travelMinutes;
            if (leaveIn <= 5) {
              next.leaveNotified = true;
              say(`🚗 Time to leave for ${destName}`, `${w.label} lands around ${fmtClock(new Date(Date.now() + prog.etaMinutes * 60_000))}.`, 'warn');
            }
          }
        }
        watchState.current.set(w.hex, next);
      }
    };
    void check();
    const t = setInterval(check, 20_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [watchlist.length, toast, recordTrail]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      toast('This browser does not support notifications — you’ll still get in-app alerts.', 'warn');
      return;
    }
    const perm = await Notification.requestPermission();
    setSettings((s) => ({ ...s, notifications: perm === 'granted' }));
    toast(perm === 'granted' ? 'Alerts enabled for My Flights.' : 'Notifications were blocked in the browser settings.', perm === 'granted' ? 'good' : 'warn');
  }, [setSettings, toast]);

  const toggleWatch = useCallback(() => {
    if (!selectedHex) return;
    const exists = watchlist.some((w) => w.hex === selectedHex);
    if (exists) {
      setWatchlist((l) => l.filter((w) => w.hex !== selectedHex));
      toast('Removed from My Flights');
    } else {
      const label = details?.route?.callsignIata ?? selected?.callsign ?? selected?.reg ?? selectedHex.toUpperCase();
      setWatchlist((l) => [...l, { hex: selectedHex, callsign: selected?.callsign ?? null, label, addedAt: Date.now() }]);
      toast(`★ ${label} added to My Flights — we’ll alert you on takeoff, descent and landing.`, 'good');
      if (!settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') void enableNotifications();
    }
  }, [selectedHex, watchlist, setWatchlist, details, selected, toast, settings.notifications, enableNotifications]);

  const showKnown = useCallback(
    (f: KnownFlight) => {
      setKnown(f);
      setSelectedHex(null);
      setPanel('estimated');
      setUrl({ flight: null, airport: null });
      const est = estimatePosition(f.status, f.route.origin, f.route.destination);
      if (est) mapRef.current?.flyTo(est.lat, est.lon, 6);
      else if (f.route.origin && f.route.destination)
        mapRef.current?.fitPoints([
          [f.route.origin.lat, f.route.origin.lon],
          [f.route.destination.lat, f.route.destination.lon],
        ]);
    },
    [setUrl],
  );

  // While the estimated panel is open: refresh the schedule status, move the estimate, and
  // switch to the live aircraft the moment any network picks it up.
  useEffect(() => {
    if (panel !== 'estimated' || !known) return;
    const cs = known.callsign;
    let stopped = false;
    const tick = setInterval(() => setEstimateTick((n) => n + 1), 30_000);
    const look = async () => {
      try {
        const r = await api.byCallsign(cs);
        if (!stopped && r.aircraft) {
          toast(`📡 ${known.flightNumber} is now live — showing its real position.`, 'good', r.aircraft.hex);
          selectFlight(r.aircraft.hex, r.aircraft, true);
          return;
        }
      } catch {
        /* keep estimating */
      }
      if (statusEnabled) {
        api
          .status(cs)
          .then((r) => !stopped && r.status && setKnown((k) => (k && k.callsign === cs ? { ...k, status: r.status } : k)))
          .catch(() => undefined);
      }
    };
    const poll = setInterval(look, 60_000);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [panel, known?.callsign, statusEnabled]);

  const estimate = useMemo(
    () => (panel === 'estimated' && known ? estimatePosition(known.status, known.route.origin, known.route.destination) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panel, known, estimateTick],
  );
  const ghost = useMemo(
    () =>
      estimate && known?.route.origin && known.route.destination
        ? {
            lat: estimate.lat,
            lon: estimate.lon,
            track: estimate.track,
            label: known.flightNumber,
            origin: [known.route.origin.lat, known.route.origin.lon] as [number, number],
            destination: [known.route.destination.lat, known.route.destination.lon] as [number, number],
          }
        : null,
    [estimate, known],
  );

  const watchKnown = useCallback(
    (f: KnownFlight) => {
      const id = `cs:${f.callsign}`;
      const routeLabel = `${codeOf(f.route.origin)} → ${codeOf(f.route.destination)}`;
      setWatchlist((l) => (l.some((w) => w.hex === id || (w.callsign && w.callsign === f.callsign)) ? l : [...l, { hex: id, callsign: f.callsign, label: f.flightNumber, addedAt: Date.now(), routeLabel }]));
      setPanel((p) => (p === 'estimated' ? p : 'watchlist'));
      toast(`🔔 We'll let you know as soon as ${f.flightNumber} (${routeLabel}) is picked up by a receiver.`, 'good');
      if (!settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') void enableNotifications();
    },
    [setWatchlist, toast, settings.notifications, enableNotifications],
  );

  const setTravel = useCallback(
    (minutes: number | undefined) => {
      if (!selectedHex) return;
      setWatchlist((l) => {
        const label = details?.route?.callsignIata ?? selected?.callsign ?? selectedHex.toUpperCase();
        const exists = l.some((w) => w.hex === selectedHex);
        if (!exists && minutes === undefined) return l;
        return exists
          ? l.map((w) => (w.hex === selectedHex ? { ...w, travelMinutes: minutes } : w))
          : [...l, { hex: selectedHex, callsign: selected?.callsign ?? null, label, addedAt: Date.now(), travelMinutes: minutes }];
      });
      watchState.current.delete(selectedHex);
    },
    [selectedHex, setWatchlist, details, selected],
  );

  // ---------------------------------------------------------------- geolocation
  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setLocError('Location is not available in this browser.');
      return;
    }
    setLocating(true);
    setLocError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setUserLoc(loc);
        setLocating(false);
        mapRef.current?.flyTo(loc.lat, loc.lon, 9);
      },
      (err) => {
        setLocating(false);
        setLocError(err.code === err.PERMISSION_DENIED ? 'Location permission was denied. You can allow it in your browser’s site settings.' : 'Couldn’t determine your location. Try again.');
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  const openPanel = useCallback(
    (p: PanelKind) => {
      setPanel((cur) => (cur === p ? null : p));
      if (p === 'overhead' && !userLoc) locate();
      else if (p === 'overhead' && userLoc) mapRef.current?.flyTo(userLoc.lat, userLoc.lon, 9);
    },
    [userLoc, locate],
  );

  // ---------------------------------------------------------------- radar feed + voice
  // The radar has its own data around the user (independent of where the map is panned),
  // so moving the map never makes aircraft "leave" the radar.
  const [radarLive, setRadarLive] = useState<Aircraft[]>([]);
  const [radarEst, setRadarEst] = useState<EstimatedAircraft[]>([]);
  const [radarVersion, setRadarVersion] = useState(0);
  const radarActive = panel === 'overhead' && !!userLoc;
  useEffect(() => {
    if (!radarActive || !userLoc) return;
    let stopped = false;
    const r = overheadRadius * 1.1;
    const dLat = r / 60;
    const dLon = r / (60 * Math.max(0.2, Math.cos((userLoc.lat * Math.PI) / 180)));
    const box = { n: userLoc.lat + dLat, s: userLoc.lat - dLat, e: userLoc.lon + dLon, w: userLoc.lon - dLon };
    let tick = 0;
    const load = async () => {
      try {
        const [live, est] = await Promise.all([
          api.bounds(box),
          tick++ % 5 === 0 && settings.showEstimated ? api.estimated(box) : Promise.resolve(null),
        ]);
        if (stopped) return;
        setRadarLive(merger.current.merge(live.aircraft));
        if (est) setRadarEst(est.aircraft);
        setRadarVersion((v) => v + 1);
      } catch {
        /* keep last radar picture */
      }
    };
    void load();
    const t = setInterval(load, 6_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [radarActive, userLoc, overheadRadius, settings.showEstimated]);

  const radarTargets = useMemo(() => {
    const liveHex = new Set(radarLive.map((a) => a.hex));
    const liveCs = new Set(radarLive.map((a) => a.callsign).filter(Boolean));
    return toTargets(
      radarLive,
      radarEst.filter((e) => !liveHex.has(e.hex) && !liveCs.has(e.callsign)),
    );
  }, [radarLive, radarEst]);

  const voice = useRadarVoice({
    enabled: settings.voice,
    active: radarActive,
    location: userLoc,
    radiusNm: overheadRadius,
    units: settings.units,
    targets: radarTargets,
    version: radarVersion,
  });

  const toggleVoice = useCallback(() => {
    if (!voice.supported) {
      toast('Your browser does not support spoken announcements.', 'warn');
      return;
    }
    const on = !settings.voice;
    setSettings((s) => ({ ...s, voice: on }));
    // Speaking right after the click also unlocks audio in browsers that block autoplay.
    voice.announce(on ? 'Voice announcements on.' : 'Voice announcements off.');
  }, [settings.voice, setSettings, voice, toast]);

  // Fit the map to the radar range (debounced, so dragging the slider stays smooth).
  useEffect(() => {
    if (panel !== 'overhead' || !userLoc) return;
    const t = setTimeout(() => {
      const r = overheadRadius;
      const dLat = r / 60;
      const dLon = r / (60 * Math.max(0.2, Math.cos((userLoc.lat * Math.PI) / 180)));
      mapRef.current?.fitPoints([
        [userLoc.lat - dLat, userLoc.lon - dLon],
        [userLoc.lat + dLat, userLoc.lon + dLon],
      ]);
    }, 350);
    return () => clearTimeout(t);
  }, [overheadRadius, panel, userLoc]);

  // ---------------------------------------------------------------- share
  const share = useCallback(async () => {
    const url = window.location.href;
    const title = selected ? `Track ${details?.route?.callsignIata ?? selected.callsign ?? 'this flight'} live on Flyby` : 'Flyby live flight tracker';
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Link copied — anyone with it can follow along live.', 'good');
    } catch {
      /* user cancelled */
    }
  }, [selected, details, toast]);

  // ---------------------------------------------------------------- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        setPanel(null);
        setSelectedHex(null);
        setUrl({ flight: null, airport: null });
      } else if (e.key === 'm') openPanel('watchlist');
      else if (e.key === 'o') openPanel('overhead');
      else if (e.key === 'f') openPanel('filters');
      else if (e.key === 'a') openPanel('alerts');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPanel, setUrl]);

  // ---------------------------------------------------------------- derived
  const watchedSet = useMemo(() => new Set(watchlist.map((w) => w.hex)), [watchlist]);

  const displayed = useMemo(() => {
    const map = new Map<string, Aircraft>();
    for (const a of area.aircraft) if (passesFilters(a, filters) || a.hex === selectedHex || watchedSet.has(a.hex)) map.set(a.hex, a);
    if (showMilitary && military) for (const a of military) if (!map.has(a.hex)) map.set(a.hex, a);
    if (selected && !map.has(selected.hex)) map.set(selected.hex, selected);
    return [...map.values()];
  }, [area.aircraft, filters, selectedHex, watchedSet, showMilitary, military, selected]);

  // Never show an estimate for a plane we can currently hear (or the one open in the estimate panel).
  const shownEstimated = useMemo(() => {
    if (!settings.showEstimated) return [];
    const live = new Set(area.aircraft.map((a) => a.hex));
    for (const a of displayed) live.add(a.hex);
    const liveCs = new Set(area.aircraft.map((a) => a.callsign).filter(Boolean));
    return estimatedList.filter((e) => {
      if (live.has(e.hex) || liveCs.has(e.callsign)) return false;
      if (panel === 'estimated' && known?.callsign === e.callsign) return false;
      const alt = e.alt ?? 0;
      if (alt < filters.minAlt || (filters.maxAlt < 50000 && alt > filters.maxAlt)) return false;
      if (!filters.kinds.airliner) return false;
      if (filters.query && !`${e.callsign} ${e.flightNumber ?? ''} ${e.reg ?? ''} ${e.type ?? ''}`.toUpperCase().includes(filters.query.toUpperCase())) return false;
      return true;
    });
  }, [estimatedList, area.aircraft, displayed, settings.showEstimated, panel, known?.callsign, filters]);

  const openEstimated = useCallback(
    (e: EstimatedAircraft) => {
      if (!e.origin || !e.destination) {
        toast(`${e.callsign}: estimated from its last heading only — its route is unknown, so there are no more details.`, 'warn');
        return;
      }
      const route = {
        callsign: e.callsign,
        callsignIata: e.flightNumber,
        airline: e.airline ? { name: e.airline, icao: null, iata: null } : null,
        origin: e.origin,
        destination: e.destination,
        source: 'estimate',
      };
      const open = (status: KnownFlight['status']) => showKnown({ callsign: e.callsign, flightNumber: e.flightNumber ?? e.callsign, route, status });
      // Real schedule data (FlightAware) wins; otherwise use the layer's own estimate so the
      // panel and the map agree on where the plane is.
      const fallback = statusFromEstimate(e);
      api
        .status(e.callsign)
        .then((r) => open(r.status?.source === 'flightaware' ? r.status : fallback))
        .catch(() => open(fallback));
    },
    [showKnown, toast],
  );

  const stats = useMemo(() => {
    let highest: Aircraft | null = null;
    let fastest: Aircraft | null = null;
    for (const a of displayed) {
      if (a.onGround) continue;
      if ((a.alt ?? 0) > (highest?.alt ?? -1)) highest = a;
      if ((a.gs ?? 0) > (fastest?.gs ?? -1)) fastest = a;
    }
    return { highest, fastest };
  }, [displayed]);

  const trail = useMemo(
    () => (selectedHex && settings.showTrails ? (trails.current.get(selectedHex) ?? []).map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedHex, trailVersion, settings.showTrails],
  );
  const history = useMemo(
    () => (selectedHex ? (trails.current.get(selectedHex) ?? []).map((p) => ({ t: p.t, alt: p.alt, gs: p.gs })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedHex, trailVersion],
  );
  const route = useMemo(() => {
    const r = details?.routeConfidence === 'low' ? null : details?.route;
    if (!r) return null;
    return {
      origin: r.origin ? ([r.origin.lat, r.origin.lon] as [number, number]) : null,
      destination: r.destination ? ([r.destination.lat, r.destination.lon] as [number, number]) : null,
    };
  }, [details]);

  const alertCount = alerts?.length ?? 0;

  const CONN_TEXT: Record<Conn, string> = {
    connecting: 'Connecting…',
    waking: 'Waking up data service…',
    live: 'Live',
    degraded: 'Live · backup source',
    offline: 'Reconnecting… showing last positions',
  };

  // ---------------------------------------------------------------- render
  return (
    <div className={`app ${panel ? 'has-panel' : ''}`}>
      <MapView
        ref={mapRef}
        aircraft={displayed}
        receivedAt={area.receivedAt}
        selectedHex={selectedHex}
        watched={watchedSet}
        trail={trail}
        route={route}
        airports={mapAirports}
        showAirports={settings.showAirports}
        mapStyle={settings.mapStyle}
        cartoKey={cartoKey}
        ghost={ghost}
        estimated={shownEstimated}
        onEstimated={openEstimated}
        units={settings.units}
        userLocation={userLoc}
        overheadRadiusNm={panel === 'overhead' ? overheadRadius : null}
        initialView={view}
        onSelect={(hex) => selectFlight(hex, hex ? displayed.find((a) => a.hex === hex) : null)}
        onAirport={openAirport}
        onBounds={setBounds}
      />

      <div className="topbar">
        <div className="brand" title="Flyby">
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden>
            <path fill="currentColor" d="M32 6c2 0 3.5 2 3.5 5v14l20 12v5l-20-6v12l6 4.5V56L32 53l-9.5 3v-3.5l6-4.5V36l-20 6v-5l20-12V11c0-3 1.5-5 3.5-5z" />
          </svg>
          <span>Flyby</span>
        </div>
        <SearchBox
          ref={searchRef}
          units={settings.units}
          recent={recent}
          onWatchKnown={watchKnown}
          onShowKnown={showKnown}
          onRecent={(q) => q && setRecent((r) => [q, ...r.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6))}
          onFlight={(a) => selectFlight(a.hex, a, true)}
          onAirport={(a) => {
            openAirport(a.iata ?? a.icao);
            mapRef.current?.flyTo(a.lat, a.lon, 10);
          }}
        />
        <div className={`conn conn-${conn}`} title={area.source ? `Data: ${area.source}` : undefined} role="status">
          <span className="conn-dot" />
          <span className="conn-text">{CONN_TEXT[conn]}</span>
        </div>
      </div>

      <nav className="dock" aria-label="Main">
        {(
          [
            ['overhead', '📍', 'Above me'],
            ['watchlist', '★', 'My Flights'],
            ['alerts', '🚨', 'Alerts'],
            ['filters', '⚲', 'Filters'],
            ['settings', '⚙', 'Settings'],
          ] as [PanelKind, string, string][]
        ).map(([k, icon, label]) => (
          <button key={k} className={`dock-btn ${panel === k ? 'active' : ''}`} onClick={() => openPanel(k)} aria-pressed={panel === k}>
            <span className="dock-icon" aria-hidden>
              {icon}
            </span>
            <span className="dock-label">{label}</span>
            {k === 'watchlist' && watchlist.length > 0 && <span className="badge">{watchlist.length}</span>}
            {k === 'alerts' && alertCount > 0 && <span className="badge danger">{alertCount}</span>}
          </button>
        ))}
      </nav>

      {panel && (
        <aside className="panel" aria-label="Details">
          {panel === 'flight' && selectedHex && (
            <FlightPanel
              hex={selectedHex}
              live={selected}
              details={details}
              detailsError={detailsError}
              history={history}
              units={settings.units}
              watch={watchlist.find((w) => w.hex === selectedHex)}
              onToggleWatch={toggleWatch}
              statusEnabled={statusEnabled}
              onSetTravel={setTravel}
              onClose={() => selectFlight(null)}
              onAirport={openAirport}
              onLocate={() => selected && mapRef.current?.flyTo(selected.lat, selected.lon)}
              onShare={share}
              onEstimate={() => {
                const r = details?.route;
                if (!r) return;
                const cs = r.callsign;
                const open = (status: KnownFlight['status']) => showKnown({ callsign: cs, flightNumber: r.callsignIata ?? cs, route: r, status });
                api
                  .status(cs)
                  .then((x) => open(x.status))
                  .catch(() => open(null));
              }}
            />
          )}
          {panel === 'estimated' && known && (
            <EstimatedPanel
              flight={known}
              estimate={estimate}
              statusEnabled={statusEnabled}
              watched={watchlist.some((w) => w.hex === `cs:${known.callsign}` || w.callsign === known.callsign)}
              onWatch={() => watchKnown(known)}
              onLocate={() => estimate && mapRef.current?.flyTo(estimate.lat, estimate.lon, 6)}
              onAirport={openAirport}
              onClose={() => {
                setPanel(null);
                setKnown(null);
              }}
            />
          )}
          {panel === 'airport' && airportCode && (
            <AirportPanel
              code={airportCode}
              units={settings.units}
              onClose={() => {
                setPanel(null);
                setUrl({ airport: null });
              }}
              onSelect={(a) => selectFlight(a.hex, a, true)}
              onLocate={(lat, lon) => mapRef.current?.flyTo(lat, lon, 9)}
              onShare={share}
            />
          )}
          {panel === 'overhead' && (
            <OverheadPanel
              location={userLoc}
              locating={locating}
              locError={locError}
              aircraft={radarLive.length || radarVersion ? radarLive : area.aircraft}
              radiusNm={overheadRadius}
              voiceOn={settings.voice}
              voiceSupported={voice.supported}
              caption={settings.voice ? voice.caption : null}
              onToggleVoice={toggleVoice}
              units={settings.units}
              onRadius={setOverheadRadius}
              estimated={radarVersion ? radarEst.filter((e) => !radarLive.some((a) => a.hex === e.hex || a.callsign === e.callsign)) : shownEstimated}
              onEstimated={openEstimated}
              onLocate={locate}
              onSelect={(a) => selectFlight(a.hex, a)}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === 'watchlist' && (
            <WatchlistPanel
              items={watchlist}
              live={watchLive}
              units={settings.units}
              notifications={settings.notifications}
              onEnableNotifications={enableNotifications}
              onSelect={(hex) => {
                if (hex.startsWith('cs:')) {
                  // Not visible yet: open the schedule/estimate view instead.
                  api
                    .search(hex.slice(3))
                    .then((r) => (r.knownFlight ? showKnown(r.knownFlight) : toast('No details available for this flight yet.', 'warn')))
                    .catch(() => toast('Couldn’t load this flight right now — try again shortly.', 'warn'));
                  return;
                }
                const a = watchLive[hex] ?? null;
                selectFlight(hex, a, true);
              }}
              onRemove={(hex) => setWatchlist((l) => l.filter((w) => w.hex !== hex))}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === 'alerts' && (
            <AlertsPanel
              alerts={alerts}
              military={military}
              showMilitary={showMilitary}
              units={settings.units}
              onToggleMilitary={() => setShowMilitary((v) => !v)}
              onSelect={(a) => selectFlight(a.hex, a, true)}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === 'filters' && (
            <FiltersPanel filters={filters} onChange={setFilters} shown={displayed.length} total={area.aircraft.length} units={settings.units} onClose={() => setPanel(null)} />
          )}
          {panel === 'settings' && (
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onEnableNotifications={enableNotifications}
              onToggleVoice={toggleVoice}
              onClose={() => setPanel(null)}
            />
          )}
        </aside>
      )}

      <div className="statsbar">
        <span>
          <b>{displayed.length.toLocaleString()}</b> aircraft in view
        </span>
        {stats.highest && (
          <button className="link" onClick={() => selectFlight(stats.highest!.hex, stats.highest)}>
            ⬆ Highest {fmtAlt(stats.highest.alt, settings.units)}
          </button>
        )}
        {stats.fastest && (
          <button className="link" onClick={() => selectFlight(stats.fastest!.hex, stats.fastest)}>
            ⚡ Fastest {fmtSpeed(stats.fastest.gs, settings.units)}
          </button>
        )}
        {shownEstimated.length > 0 && (
          <span className="warn-text" title="Flights that recently left receiver coverage, moved forward along their route">
            +{shownEstimated.length} estimated
          </span>
        )}
        {area.truncated && <span className="warn-text">Zoom in to see all traffic</span>}
        {filters !== DEFAULT_FILTERS && JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
          <button className="link warn-text" onClick={() => setFilters(DEFAULT_FILTERS)}>
            Filters on · clear
          </button>
        )}
      </div>

      <div className="legend" aria-hidden>
        <div className="legend-bar" />
        <div className="legend-labels">
          <span>0</span>
          <span>10k</span>
          <span>20k</span>
          <span>30k</span>
          <span>40k ft</span>
        </div>
        {settings.showEstimated && (
          <div className="legend-est">
            <i /> dashed = estimated
          </div>
        )}
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.tone ?? ''}`}
            onClick={() => {
              if (t.hex) selectFlight(t.hex, watchLive[t.hex] ?? null, true);
              setToasts((l) => l.filter((x) => x.id !== t.id));
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
