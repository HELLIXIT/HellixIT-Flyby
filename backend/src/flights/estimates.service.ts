import { Injectable, Logger } from '@nestjs/common';
import { angleDiff, bearingDeg, distanceNm } from '../common/geo';
import { InfoService, RouteInfo } from '../info/info.service';
import { Sighting, SightingsService } from '../status/sightings.service';
import { Bounds, FlightsService } from './flights.service';
import { AirportsService } from '../airports/airports.service';
import { StatusService } from '../status/status.service';

/** Silent this long before we call it "estimated" (shorter gaps are normal between updates). */
const MIN_SILENT_MS = 90_000;
/** Stop estimating after this long without a signal (route-based; ends earlier on landing). */
const MAX_SILENT_MS = Number(process.env.ESTIMATE_MAX_MINUTES ?? 840) * 60_000;
/** Silent longer than this + known route: the viewport's own live data is the presence check. */
const LONG_SILENT_MS = 60 * 60_000;
/** Without a known route we only extrapolate the last heading for this long. */
const DR_MAX_MS = 20 * 60_000;
/** Route lookups started per request (results arrive on the next poll). */
const ROUTE_LOOKUPS_PER_CALL = 10;
/** Departures-index flights: consider those that went silent within this window. */
const DEP_WINDOW_MS = 14 * 3600_000;
const TYPICAL_KT = 440;

export interface EstimatedAircraft {
  hex: string;
  callsign: string;
  reg: string | null;
  type: string | null;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number;
  /** Seconds since any network last heard it. */
  silentSec: number;
  /** 'route' = from last sighting along its route; 'heading' = last heading only;
   *  'departure' = from its take-off time along the route (OpenSky departures index);
   *  'schedule' = from its schedule/status times along the route (never heard by a receiver);
   *  'flightaware' = position from FlightAware's area search (their receivers/satellite/projection). */
  method: 'route' | 'heading' | 'departure' | 'schedule' | 'flightaware';
  lastSeenSource: string;
  origin: RouteInfo['origin'];
  destination: RouteInfo['destination'];
  flightNumber: string | null;
  airline: string | null;
  /** Minutes until estimated landing (route method only). */
  etaMinutes: number | null;
}

/**
 * "Estimated aircraft" layer: flights that recently went silent (left receiver coverage) are
 * moved forward along their route — like the big trackers do over oceans and thin-coverage
 * countries. Built only from data we observed ourselves; clearly flagged as estimates.
 */
@Injectable()
export class EstimatesService {
  private readonly logger = new Logger(EstimatesService.name);

  constructor(
    private readonly sightings: SightingsService,
    private readonly info: InfoService,
    private readonly flights: FlightsService,
    private readonly airports: AirportsService,
    private readonly status: StatusService,
  ) {}

  private lastUsed = 0;
  private resolver: ReturnType<typeof setInterval> | null = null;

  /**
   * While the app is in use, steadily look up routes for recent departures and long-silent
   * sightings (most recent first, one every 2 s), so overflights like Jakarta → Jeddah over
   * Sri Lanka get a route — and therefore an estimated position — without being searched.
   */
  private ensureResolver() {
    this.lastUsed = Date.now();
    if (this.resolver) return;
    this.resolver = setInterval(() => {
      if (Date.now() - this.lastUsed > 10 * 60_000) {
        clearInterval(this.resolver!);
        this.resolver = null;
        return;
      }
      const next = this.nextUnresolved();
      if (next) void this.info.route(next);
    }, 2_000);
    this.resolver.unref?.();
  }

  /**
   * Which unknown route to look up next. Ranked by how plausibly the flight is inside the
   * last-viewed area *right now*: distance from where it was (take-off airport or last
   * sighting) to the view, compared with how far it can have flown since. Flights that can't
   * be anywhere near the view are skipped entirely.
   */
  private nextUnresolved(): string | null {
    const v = this.lastView;
    if (!v) return null;
    const now = Date.now();
    const cLat = (v.north + v.south) / 2;
    const cLon = (v.east + v.west) / 2;
    const viewRadius = distanceNm(cLat, cLon, v.north, v.east);
    let best: { cs: string; score: number } | null = null;
    const consider = (cs: string, lat: number, lon: number, sinceMs: number) => {
      if (this.tried.has(cs) || this.info.peekRoute(cs) !== undefined) return;
      const reach = (480 * sinceMs) / 3_600_000; // nm it can have flown
      const dist = distanceNm(lat, lon, cLat, cLon);
      if (dist > reach + viewRadius + 150) return; // can't have reached the view yet
      const score = Math.abs(reach - dist); // ≈ 0 → it should be about here now
      if (!best || score < best.score) best = { cs, score };
    };
    for (const d of this.sightings.recentDepartures(DEP_WINDOW_MS)) {
      const from = d.from ? this.airports.get(d.from) : null;
      if (from) consider(d.callsign, from.lat, from.lon, now - d.firstSeen * 1000);
    }
    for (const s of this.sightings.recent(MAX_SILENT_MS)) {
      if (now - s.at < 10 * 60_000 || s.onGround || (s.alt ?? 0) < 5_000) continue;
      consider(s.callsign, s.lat, s.lon, now - s.at);
    }
    const pick = best as { cs: string; score: number } | null;
    if (pick) {
      this.tried.add(pick.cs);
      if (this.tried.size > 50_000) this.tried.clear();
    }
    return pick?.cs ?? null;
  }

  private lastView: Bounds | null = null;
  /** Callsigns already queued (the route cache answers next time; avoids re-picking misses). */
  private readonly tried = new Set<string>();

  inBounds(b: Bounds): EstimatedAircraft[] {
    this.lastView = b;
    this.ensureResolver();
    // Learn about flights heading into this area from the surrounding regions (background).
    void this.flights.learnAround(b).catch(() => undefined);

    const now = Date.now();
    this.loadGapAirportBoards(b, now);
    const out: EstimatedAircraft[] = [];
    let lookups = 0;
    for (const s of this.sightings.recent(MAX_SILENT_MS)) {
      const silent = now - s.at;
      if (silent < MIN_SILENT_MS || s.onGround) continue;
      if ((s.alt ?? 0) < 5_000 || (s.gs ?? 0) < 150) continue; // landing/low & slow: too unpredictable
      // Only if we looked at its last position again since and it wasn't there — otherwise
      // it's probably still flying normally in an area nobody is viewing right now.
      const route = this.info.peekRoute(s.callsign);
      // (Long-silent flights with a known route are far from where they were last heard; whether
      // they're live is then decided by the live data of the area they're projected into.)
      const longGone = silent > LONG_SILENT_MS && !!route?.destination;
      if (!longGone && !this.sightings.checkedSince(s.lat, s.lon, s.at + 30_000)) continue;

      if (route === undefined && lookups < ROUTE_LOOKUPS_PER_CALL && this.couldBeNear(s, silent, b)) {
        lookups++;
        void this.info.route(s.callsign); // cached for the next poll
      }
      const est = this.project(s, route ?? null, now);
      if (est && inside(est.lat, est.lon, b)) out.push(est);
    }

    // Second source: flights OpenSky saw take off and then lose (e.g. over oceans). We know
    // when they took off; with their route we can place them along it.
    const seen = new Set(out.map((e) => e.callsign));
    const cLat = (b.north + b.south) / 2;
    const cLon = (b.east + b.west) / 2;
    const pending: { cs: string; dist: number }[] = [];
    for (const d of this.sightings.recentDepartures(DEP_WINDOW_MS)) {
      if (seen.has(d.callsign)) continue;
      const fresh = this.sightings.sighting(d.callsign);
      if (fresh && fresh.at > d.lastSeen * 1000) continue; // seen again since: handled above (or live)
      const route = this.info.peekRoute(d.callsign);
      if (route === undefined) {
        const from = d.from ? this.airports.get(d.from) : null;
        if (from) pending.push({ cs: d.callsign, dist: distanceNm(cLat, cLon, from.lat, from.lon) });
        continue;
      }
      if (!route?.origin || !route.destination) continue;
      if (d.from && route.origin.icao !== d.from) continue; // route DB disagrees with what was observed
      const est = this.fromDeparture(d.callsign, d.hex, d.firstSeen * 1000, d.lastSeen * 1000, route, now);
      if (est && inside(est.lat, est.lon, b)) out.push(est);
    }
    // Third source: airborne flights whose schedule/status was looked up (search, panels, watch list).
    for (const k of this.status.knownAirborne()) {
      if (out.some((e) => e.callsign === k.callsign)) continue;
      const heard = this.sightings.sighting(k.callsign);
      if (heard && now - heard.at < MIN_SILENT_MS) continue; // live right now
      const t = k.status.times;
      const dep = Date.parse(t.actualOff ?? t.actualOut ?? t.estimatedOff ?? t.scheduledOff ?? '');
      const arr = Date.parse(t.estimatedOn ?? t.scheduledOn ?? t.estimatedIn ?? t.scheduledIn ?? '');
      const o = k.route.origin!;
      const d = k.route.destination!;
      if (!Number.isFinite(dep) || !Number.isFinite(arr) || arr <= dep || now < dep || now >= arr) continue;
      const f = (now - dep) / (arr - dep);
      const [lat, lon] = along(o.lat, o.lon, d.lat, d.lon, f);
      if (!inside(lat, lon, b)) continue;
      const total = distanceNm(o.lat, o.lon, d.lat, d.lon);
      const left = total * (1 - f);
      out.push({
        hex: k.status.hex ?? heard?.hex ?? `cs-${k.callsign}`,
        callsign: k.callsign,
        reg: k.status.registration ?? heard?.reg ?? null,
        type: k.status.aircraftType ?? heard?.type ?? null,
        lat,
        lon,
        alt: left < 120 ? Math.round(Math.max(3_000, left * 300) / 100) * 100 : heard?.alt ?? 35_000,
        gs: Math.round((total / ((arr - dep) / 3_600_000)) || TYPICAL_KT),
        track: bearingDeg(lat, lon, d.lat, d.lon),
        silentSec: heard ? Math.round((now - heard.at) / 1000) : -1,
        method: 'schedule',
        lastSeenSource: k.status.source === 'flightaware' ? 'FlightAware schedule' : 'Flyby estimate',
        origin: o as RouteInfo['origin'],
        destination: d as RouteInfo['destination'],
        flightNumber: k.status.identIata ?? null,
        airline: null,
        etaMinutes: Math.round((arr - now) / 60_000),
      });
    }

    // Fourth source: FlightAware's own positions for receiver-less areas (incl. overflights).
    for (const f of this.gapAreaFlights(b, now)) {
      if (!f.callsign || out.some((e) => e.callsign === f.callsign)) continue;
      const heard = this.sightings.sighting(f.callsign);
      if (heard && now - heard.at < MIN_SILENT_MS) continue; // a free network hears it: it's live
      const age = Math.min(20 * 60_000, Math.max(0, now - f.at));
      const [lat, lon] =
        f.heading !== null && f.gs ? destinationPoint(f.lat, f.lon, f.heading, (f.gs * age) / 3_600_000) : [f.lat, f.lon];
      if (!inside(lat, lon, b)) continue;
      const o = f.origin ? this.airports.get(f.origin) : null;
      const d = f.destination ? this.airports.get(f.destination) : null;
      const how: Record<string, string> = { A: 'ADS-B', M: 'MLAT', Z: 'radar', S: 'satellite', O: 'oceanic report', D: 'datalink', P: 'projected', X: 'surface' };
      out.push({
        hex: heard?.hex ?? `fa-${f.callsign}`,
        callsign: f.callsign,
        reg: heard?.reg ?? null,
        type: f.type,
        lat,
        lon,
        alt: f.alt,
        gs: f.gs,
        track: f.heading ?? 0,
        silentSec: Math.round((now - f.at) / 1000),
        method: 'flightaware',
        lastSeenSource: `FlightAware (${how[f.updateType ?? ''] ?? 'position'})`,
        origin: (o as RouteInfo['origin']) ?? null,
        destination: (d as RouteInfo['destination']) ?? null,
        flightNumber: f.identIata,
        airline: null,
        etaMinutes: d && f.gs ? Math.round((distanceNm(lat, lon, d.lat, d.lon) / Math.max(250, f.gs)) * 60 + 8) : null,
      });
    }

    // Look up routes for the nearest unknown departures first; results land in the cache for the next poll.
    pending.sort((x, y) => x.dist - y.dist);
    for (const p of pending.slice(0, Math.max(0, ROUTE_LOOKUPS_PER_CALL - lookups))) void this.info.route(p.cs);
    return out;
  }

  private fromDeparture(cs: string, hex: string, firstSeen: number, lastSeen: number, route: RouteInfo, now: number): EstimatedAircraft | null {
    const o = route.origin!;
    const d = route.destination!;
    const total = distanceNm(o.lat, o.lon, d.lat, d.lon);
    if (total < 150) return null;
    const takeoff = firstSeen + 2 * 60_000;
    const flown = (TYPICAL_KT * Math.max(0, now - takeoff - 10 * 60_000)) / 3_600_000; // ~10 min climb-out
    if (flown >= total) return null; // should have landed
    const [lat, lon] = along(o.lat, o.lon, d.lat, d.lon, flown / total);
    const left = total - flown;
    return {
      hex,
      callsign: cs,
      reg: null,
      type: null,
      lat,
      lon,
      alt: left < 120 ? Math.round(Math.max(3_000, left * 300) / 100) * 100 : 36_000,
      gs: TYPICAL_KT,
      track: bearingDeg(lat, lon, d.lat, d.lon),
      silentSec: Math.round((now - lastSeen) / 1000),
      method: 'departure',
      lastSeenSource: 'OpenSky',
      origin: o,
      destination: d,
      flightNumber: route.callsignIata ?? null,
      airline: route.airline?.name ?? null,
      etaMinutes: Math.round((left / TYPICAL_KT) * 60 + 8),
    };
  }

  /**
   * Major airports in view that no receiver covers (almost nothing heard nearby recently):
   * fetch their departure boards so departing flights appear without being searched.
   */
  private loadGapAirportBoards(b: Bounds, now: number) {
    if (!this.status.enabled) return;
    const inView = this.airports.major().filter((a) => inside(a.lat, a.lon, b));
    if (!inView.length || inView.length > 12) return; // only for regional views
    const recent = this.sightings.recent(15 * 60_000).filter((s) => now - s.at < 15 * 60_000);
    const gaps = inView.filter((ap) => recent.filter((s) => distanceNm(ap.lat, ap.lon, s.lat, s.lon) < 120).length < 3);
    for (const ap of gaps.slice(0, 2)) void this.status.airportBoard(ap.icao);
  }

  /** FlightAware area search, only for regional views the free networks barely cover. */
  private gapAreaFlights(b: Bounds, now: number) {
    if (!this.status.enabled) return [];
    const span = Math.max(b.north - b.south, b.east - b.west);
    if (span > 25 || span < 0.5) return [];
    const heard = this.sightings.recent(10 * 60_000).filter((s) => now - s.at < 10 * 60_000 && inside(s.lat, s.lon, b)).length;
    if (heard >= 8) return [];
    return this.status.areaFlights(b);
  }

  private project(s: Sighting, route: RouteInfo | null, now: number): EstimatedAircraft | null {
    const silent = now - s.at;
    const gs = Math.min(560, Math.max(250, s.gs ?? 440));
    const travelled = (gs * silent) / 3_600_000;
    const base = {
      hex: s.hex,
      callsign: s.callsign,
      reg: s.reg,
      type: s.type,
      alt: s.alt,
      gs: s.gs,
      silentSec: Math.round(silent / 1000),
      lastSeenSource: s.source,
      origin: route?.origin ?? null,
      destination: route?.destination ?? null,
      flightNumber: route?.callsignIata ?? null,
      airline: route?.airline?.name ?? null,
    };

    const d = route?.destination;
    if (d) {
      const remaining = distanceNm(s.lat, s.lon, d.lat, d.lon);
      const towardsDest = s.track === null || angleDiff(s.track, bearingDeg(s.lat, s.lon, d.lat, d.lon)) < 70 || remaining < 60;
      if (towardsDest && remaining > 5) {
        if (travelled >= remaining) return null; // should have landed by now
        const f = travelled / remaining;
        const [lat, lon] = along(s.lat, s.lon, d.lat, d.lon, f);
        const left = remaining - travelled;
        // Rough descent profile for the last ~120 nm.
        const alt = s.alt === null ? null : Math.round(Math.min(s.alt, Math.max(3_000, left * 300)) / 100) * 100;
        return {
          ...base,
          lat,
          lon,
          alt,
          track: bearingDeg(lat, lon, d.lat, d.lon),
          method: 'route',
          etaMinutes: Math.round((left / gs) * 60 + (left > 40 ? 8 : 3)),
        };
      }
    }
    if (s.track === null || silent > DR_MAX_MS) return null;
    const [lat, lon] = destinationPoint(s.lat, s.lon, s.track, travelled);
    return { ...base, lat, lon, track: s.track, method: 'heading', etaMinutes: null };
  }

  /** Cheap pre-filter: could this flight have reached the viewport by now? */
  private couldBeNear(s: Sighting, silentMs: number, b: Bounds) {
    const reach = ((s.gs ?? 450) * silentMs) / 3_600_000 + 60; // nm
    const cLat = Math.min(b.north, Math.max(b.south, s.lat));
    const cLon = Math.min(b.east, Math.max(b.west, s.lon));
    return distanceNm(s.lat, s.lon, cLat, cLon) <= reach;
  }
}

function inside(lat: number, lon: number, b: Bounds) {
  if (lat < b.south || lat > b.north) return false;
  if (b.east - b.west >= 360) return true;
  let x = lon;
  while (x < b.west) x += 360;
  while (x > b.east) x -= 360;
  return x >= b.west && x <= b.east;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Point a fraction f along the great circle between two points. */
function along(lat1: number, lon1: number, lat2: number, lon2: number, f: number): [number, number] {
  const [a1, o1, a2, o2] = [rad(lat1), rad(lon1), rad(lat2), rad(lon2)];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((a2 - a1) / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin((o2 - o1) / 2) ** 2));
  if (d === 0) return [lat1, lon1];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(a1) * Math.cos(o1) + B * Math.cos(a2) * Math.cos(o2);
  const y = A * Math.cos(a1) * Math.sin(o1) + B * Math.cos(a2) * Math.sin(o2);
  const z = A * Math.sin(a1) + B * Math.sin(a2);
  return [deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))];
}

/** Move along a heading by `nm` nautical miles. */
function destinationPoint(lat: number, lon: number, track: number, nm: number): [number, number] {
  const dr = nm / 3440.065;
  const t = rad(track);
  const a1 = rad(lat);
  const a2 = Math.asin(Math.sin(a1) * Math.cos(dr) + Math.cos(a1) * Math.sin(dr) * Math.cos(t));
  const o2 = rad(lon) + Math.atan2(Math.sin(t) * Math.sin(dr) * Math.cos(a1), Math.cos(dr) - Math.sin(a1) * Math.sin(a2));
  return [deg(a2), ((deg(o2) + 540) % 360) - 180];
}
