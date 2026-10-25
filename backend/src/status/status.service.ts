import { Injectable, Logger } from '@nestjs/common';
import { HttpCacheService, UpstreamError } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';
import { distanceNm } from '../common/geo';
import { flightMinutes, SightingsService, TYPICAL_KT } from './sightings.service';
import { AirportsService } from '../airports/airports.service';

/** Airport departure boards (for airports without receiver coverage): own daily cap + refresh. */
const BOARD_CAP = Number(process.env.AEROAPI_BOARD_CALLS_PER_DAY ?? 48);
const BOARD_REFRESH_MS = Number(process.env.AEROAPI_BOARD_REFRESH_MIN ?? 60) * 60_000;
const BOARD_ARRIVALS = process.env.AEROAPI_BOARD_ARRIVALS !== 'false';
/** "At the airport" lists (recent arrivals + upcoming departures), fetched when a panel opens. */
const GROUND_CAP = Number(process.env.AEROAPI_GROUND_CALLS_PER_DAY ?? 24);
const GROUND_REFRESH_MS = Number(process.env.AEROAPI_GROUND_REFRESH_MIN ?? 15) * 60_000;

export interface GroundFlight {
  ident: string;
  identIata: string | null;
  operator: string | null;
  /** The other end of the trip: where it came from (landed) or where it's going (departing). */
  otherAirport: { code: string | null; city: string | null; name: string | null } | null;
  /** Landed: actual landing/gate-in time. Departing: estimated/scheduled gate-out time. */
  time: string | null;
  scheduledTime: string | null;
  delayMin: number | null;
  gate: string | null;
  terminal: string | null;
  baggage: string | null;
  aircraftType: string | null;
  registration: string | null;
  status: string;
}

/** Area searches (airborne flights FlightAware places in a box) for receiver-less areas. */
const AREA_CAP = Number(process.env.AEROAPI_AREA_CALLS_PER_DAY ?? 24);
/** Live position lookups for flights opened in the estimated-flight panel. */
const POSITION_CAP = Number(process.env.AEROAPI_POSITION_CALLS_PER_DAY ?? 200);
/** How long a FlightAware position is reused (starred flights refresh at most this often). */
const POSITION_REFRESH_MS = Number(process.env.AEROAPI_POSITION_REFRESH_SEC ?? 120) * 1000;
const AREA_REFRESH_MS = Number(process.env.AEROAPI_AREA_REFRESH_MIN ?? 10) * 60_000;

/** A flight FlightAware positions inside a searched area. */
export interface AreaFlight {
  callsign: string;
  identIata: string | null;
  type: string | null;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  heading: number | null;
  at: number;
  /** How FlightAware got the position: A=ADS-B, M=MLAT, Z=radar, S=satellite, O=oceanic, D=datalink, P=projected (estimate). */
  updateType: string | null;
  origin: string | null;
  destination: string | null;
}

/** Minimal route shape needed for estimates (matches InfoService's RouteInfo airports). */
export interface RoutePoints {
  origin: { icao: string; iata: string | null; name: string; city: string | null; lat: number; lon: number } | null;
  destination: { icao: string; iata: string | null; name: string; city: string | null; lat: number; lon: number } | null;
}

const AEROAPI = process.env.AEROAPI_BASE_URL || 'https://aeroapi.flightaware.com/aeroapi';

export interface StatusAirport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  timezone: string | null;
}

/** Schedule-based flight status (FlightAware AeroAPI). Works where no receiver can hear the aircraft. */
export interface FlightStatus {
  /** 'flightaware' = schedule data; 'estimate' = Flyby's own estimate from the last radar contact. */
  source: 'flightaware' | 'estimate';
  /** For estimates: what it is based on, in plain words. */
  basis?: string;
  /** Aircraft hex, when known (lets us look for the aircraft by hex on every network). */
  hex?: string | null;
  ident: string;
  identIata: string | null;
  status: string;
  phase: 'scheduled' | 'taxiing' | 'airborne' | 'landed' | 'arrived' | 'cancelled' | 'diverted';
  cancelled: boolean;
  diverted: boolean;
  progressPercent: number | null;
  origin: StatusAirport | null;
  destination: StatusAirport | null;
  aircraftType: string | null;
  registration: string | null;
  departureDelayMin: number | null;
  arrivalDelayMin: number | null;
  gateOrigin: string | null;
  gateDestination: string | null;
  terminalOrigin: string | null;
  terminalDestination: string | null;
  baggageClaim: string | null;
  times: {
    scheduledOut: string | null;
    estimatedOut: string | null;
    actualOut: string | null;
    scheduledOff: string | null;
    estimatedOff: string | null;
    actualOff: string | null;
    scheduledOn: string | null;
    estimatedOn: string | null;
    actualOn: string | null;
    scheduledIn: string | null;
    estimatedIn: string | null;
    actualIn: string | null;
  };
  fetchedAt: string;
  /** FlightAware's internal flight id (needed for position lookups). */
  faFlightId?: string | null;
  /** FlightAware's latest position for this flight (their receivers/satellite/projection). */
  lastPosition?: {
    lat: number;
    lon: number;
    alt: number | null;
    gs: number | null;
    heading: number | null;
    at: string;
    /** A=ADS-B, M=MLAT, Z=radar, S=satellite, O=oceanic, D=datalink, P=projected, X=surface */
    updateType: string | null;
  } | null;
}

/**
 * Optional flight-status provider backed by FlightAware AeroAPI.
 * Disabled unless FLIGHTAWARE_AEROAPI_KEY is set. Guards the free monthly credit with a
 * daily call cap and long caching, and respects the Personal tier's 10 requests/minute.
 */
@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly key = process.env.FLIGHTAWARE_AEROAPI_KEY?.trim() || null;
  private readonly dailyCap = Number(process.env.AEROAPI_MAX_CALLS_PER_DAY ?? 30);
  private day = '';
  private callsToday = 0;
  readonly chain: ProviderChain<[string], FlightStatus | null>;

  constructor(
    private readonly http: HttpCacheService,
    private readonly sightings: SightingsService,
    private readonly airports: AirportsService,
  ) {
    this.chain = new ProviderChain(
      'flight-status',
      [{ name: 'flightaware-aeroapi', minIntervalMs: 6_000, run: (cs: string) => this.aeroapi(cs) }],
      { threshold: 2, cooldownMs: 5 * 60_000, maxCooldownMs: 60 * 60_000 },
    );
  }

  get enabled() {
    return !!this.key;
  }

  usage() {
    return { enabled: this.enabled, callsToday: this.callsToday, dailyCap: this.dailyCap, boards: this.boardUsage() };
  }

  /**
   * Status chain: FlightAware schedule data (if a key is set) → Flyby's keyless estimate from
   * the last time any network saw the flight. Returns null when neither knows anything.
   */
  async status(callsign: string, route?: RoutePoints | null): Promise<FlightStatus | null> {
    const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cs.length < 3) return null;
    let fa = await this.flightAware(cs);
    if (fa?.phase === 'airborne' && fa.faFlightId) {
      const pos = await this.position(fa.faFlightId);
      if (pos) fa = { ...fa, lastPosition: pos };
    }
    const result = fa ?? (route ? this.estimate(cs, route) : null);
    this.remember(cs, result, route ?? null);
    return result;
  }

  /**
   * Airborne flights whose status we've looked up (schedule or estimate), with their route —
   * so the estimated-aircraft layer can show flights no receiver has ever heard
   * (e.g. a Colombo departure: no receivers in Sri Lanka).
   */
  private readonly known = new Map<string, { status: FlightStatus; route: RoutePoints; at: number }>();

  private remember(cs: string, st: FlightStatus | null, route: RoutePoints | null) {
    if (st?.phase === 'airborne' && route?.origin && route.destination) this.known.set(cs, { status: st, route, at: Date.now() });
    else if (st) this.known.delete(cs);
  }

  /** Flights believed to be airborne right now, from looked-up status (expired ones pruned). */
  knownAirborne(): { callsign: string; status: FlightStatus; route: RoutePoints }[] {
    const now = Date.now();
    const out: { callsign: string; status: FlightStatus; route: RoutePoints }[] = [];
    for (const [cs, k] of this.known) {
      const t = k.status.times;
      const arr = Date.parse(t.actualOn ?? t.estimatedOn ?? t.scheduledOn ?? t.estimatedIn ?? t.scheduledIn ?? '');
      if (!Number.isFinite(arr) || now > arr + 10 * 60_000 || now - k.at > 12 * 3600_000) {
        this.known.delete(cs);
        continue;
      }
      out.push({ callsign: cs, status: k.status, route: k.route });
    }
    return out;
  }

  /** Keyless estimate: dead-reckon from our last sighting, or from OpenSky's take-off time. */
  estimate(cs: string, route: RoutePoints): FlightStatus | null {
    const o = route.origin;
    const d = route.destination;
    if (!o || !d) return null;
    const total = distanceNm(o.lat, o.lon, d.lat, d.lon);
    const now = Date.now();
    let dep: number | null = null;
    let arr: number | null = null;
    let basis = '';
    let hex: string | null = null;

    const s = this.sightings.sighting(cs);
    if (s && !s.onGround) {
      const flown = distanceNm(o.lat, o.lon, s.lat, s.lon);
      const remaining = distanceNm(s.lat, s.lon, d.lat, d.lon);
      // Only trust it if the sighting lies roughly on this route (callsigns get reused).
      if (flown + remaining <= total * 1.3 + 150) {
        const speed = Math.min(560, Math.max(300, s.gs ?? TYPICAL_KT));
        arr = s.at + ((remaining / speed) * 60 + (remaining > 100 ? 10 : 3)) * 60_000;
        const f = flown / (flown + remaining || 1);
        dep = f < 0.98 ? s.at - (f * (arr - s.at)) / (1 - f) : s.at - flightMinutes(flown) * 60_000;
        hex = s.hex;
        basis = `last seen ${ago(now - s.at)} ago by ${s.source}${s.alt ? ` at ${Math.round(s.alt / 100) * 100} ft` : ''}`;
      }
    }
    if (dep === null) {
      const r = this.sightings.departure(cs);
      if (r && (!r.from || r.from === o.icao)) {
        dep = r.firstSeen * 1000 + 2 * 60_000;
        arr = dep + flightMinutes(total) * 60_000;
        hex = r.hex;
        const left = r.lastSeen * 1000;
        basis = `took off ${ago(now - dep)} ago, last radar contact ${ago(now - left)} ago (OpenSky)`;
      }
    }
    if (dep === null || arr === null) return null;

    const landed = now > arr;
    const fraction = Math.min(1, Math.max(0, (now - dep) / (arr - dep)));
    const iso = (ms: number) => new Date(ms).toISOString();
    const ap = (a: NonNullable<RoutePoints['origin']>): StatusAirport => ({ icao: a.icao, iata: a.iata, name: a.name, city: a.city, timezone: null });
    return {
      source: 'estimate',
      basis,
      hex,
      ident: cs,
      identIata: null,
      status: landed ? 'Probably landed (estimated)' : 'Estimated — no live signal',
      phase: landed ? (now > arr + 30 * 60_000 ? 'arrived' : 'landed') : 'airborne',
      cancelled: false,
      diverted: false,
      progressPercent: Math.round(fraction * 100),
      origin: ap(o),
      destination: ap(d),
      aircraftType: null,
      registration: null,
      departureDelayMin: null,
      arrivalDelayMin: null,
      gateOrigin: null,
      gateDestination: null,
      terminalOrigin: null,
      terminalDestination: null,
      baggageClaim: null,
      times: {
        scheduledOut: null,
        estimatedOut: null,
        actualOut: null,
        scheduledOff: null,
        estimatedOff: null,
        actualOff: iso(dep),
        scheduledOn: null,
        estimatedOn: landed ? null : iso(arr),
        actualOn: landed ? iso(arr) : null,
        scheduledIn: null,
        estimatedIn: null,
        actualIn: null,
      },
      fetchedAt: iso(now),
    };
  }

  private async flightAware(cs: string): Promise<FlightStatus | null> {
    if (!this.key) return null;
    try {
      // 5 min for flights that are moving, longer otherwise; stale answers kept for 6 h if FA is unreachable.
      return await this.http.cached(`fa:${cs}`, 5 * 60_000, () => this.chain.run(cs), 6 * 3600_000);
    } catch (err) {
      this.logger.warn(`status ${cs}: ${(err as Error).message}`);
      return null;
    }
  }

  private posDay = '';
  private posCalls = 0;

  /** FlightAware's latest position for an airborne flight (cached 90 s, own daily cap). */
  private async position(faFlightId: string): Promise<FlightStatus['lastPosition']> {
    try {
      return await this.http.cached(
        `fa-pos:${faFlightId}`,
        POSITION_REFRESH_MS,
        async () => {
          const today = new Date().toISOString().slice(0, 10);
          if (today !== this.posDay) {
            this.posDay = today;
            this.posCalls = 0;
          }
          if (this.posCalls >= POSITION_CAP) return null;
          this.posCalls++;
          const res = await fetch(`${AEROAPI}/flights/${encodeURIComponent(faFlightId)}/position`, {
            headers: { 'x-apikey': this.key!, Accept: 'application/json' },
            signal: AbortSignal.timeout(12_000),
          });
          if (!res.ok) throw new UpstreamError(`${res.status} from aeroapi (position)`, res.status);
          const d = (await res.json()) as { last_position?: any };
          return toPosition(d.last_position);
        },
        5 * 60_000,
      );
    } catch (err) {
      this.logger.warn(`position ${faFlightId}: ${(err as Error).message}`);
      return null;
    }
  }

  private boardDay = '';
  private boardCalls = 0;

  /**
   * Recent departures from an airport no receiver covers (e.g. Colombo): every flight still in
   * the air is registered for the estimated-aircraft layer, so it shows without being searched.
   * Cached per airport (default 60 min) and capped per day to protect the AeroAPI credit.
   */
  airportBoard(icao: string): Promise<number> {
    if (!this.key) return Promise.resolve(0);
    return this.http
      .cached(`fa-board:${icao}`, BOARD_REFRESH_MS, () => this.fetchBoard(icao), BOARD_REFRESH_MS, BOARD_REFRESH_MS)
      .catch((err) => {
        this.logger.warn(`departure board ${icao}: ${(err as Error).message}`);
        return 0;
      });
  }

  private async fetchBoard(icao: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.boardDay) {
      this.boardDay = today;
      this.boardCalls = 0;
    }
    if (this.boardCalls >= BOARD_CAP) throw new Error('daily departure-board budget reached');
    this.boardCalls++;
    const start = new Date(Date.now() - 10 * 3600_000).toISOString().slice(0, 19) + 'Z';
    const get = async (path: string, key: string) => {
      const res = await fetch(`${AEROAPI}/airports/${encodeURIComponent(icao)}/flights/${path}`, {
        headers: { 'x-apikey': this.key!, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new UpstreamError(`${res.status} from aeroapi (${path.split('?')[0]})`, res.status);
      return ((await res.json()) as Record<string, any[]>)[key] ?? [];
    };
    const flights = await get(`departures?type=Airline&start=${start}&max_pages=1`, 'departures');
    // Inbound flights still in the air (scheduled to arrive in the next 8 h).
    if (BOARD_ARRIVALS && this.boardCalls < BOARD_CAP) {
      this.boardCalls++;
      const end = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19) + 'Z';
      const now = new Date().toISOString().slice(0, 19) + 'Z';
      flights.push(...(await get(`scheduled_arrivals?type=Airline&start=${now}&end=${end}&max_pages=1`, 'scheduled_arrivals').catch(() => [])));
    }
    let added = 0;
    for (const f of flights) {
      if (!(f.actual_off || f.actual_out) || f.actual_on || f.actual_in || f.cancelled) continue;
      const st = normalise(f);
      const o = this.airports.get(st.origin?.icao ?? st.origin?.iata ?? '');
      const d = this.airports.get(st.destination?.icao ?? st.destination?.iata ?? '');
      if (!o || !d) continue;
      this.remember(st.ident, st, { origin: o, destination: d });
      added++;
    }
    this.logger.log(`Departure board ${icao}: ${added} airborne flights registered`);
    return added;
  }

  private areaDay = '';
  private areaCalls = 0;

  /**
   * Airborne flights FlightAware places inside a box — fills areas no free receiver covers
   * (incl. overflights nobody searched for). Cached per 1°-rounded box; own daily cap.
   */
  areaFlights(b: { north: number; south: number; east: number; west: number }): AreaFlight[] {
    if (!this.key) return [];
    // Fixed 5° tiles, so panning around one region reuses the same cached searches.
    const T = 5;
    const tiles: { s: number; n: number; w: number; e: number }[] = [];
    for (let lat = Math.floor(b.south / T) * T; lat < b.north; lat += T) {
      for (let lon = Math.floor(Math.max(-180, b.west) / T) * T; lon < Math.min(180, b.east); lon += T) {
        tiles.push({ s: Math.max(-90, lat), n: Math.min(90, lat + T), w: lon, e: lon + T });
      }
    }
    if (tiles.length > 6) return []; // only for regional views
    const out: AreaFlight[] = [];
    let started = 0;
    for (const box of tiles) {
      const key = `fa-area:${box.s}:${box.w}`;
      const hit = this.http.peek<AreaFlight[]>(key);
      if (hit !== undefined) {
        out.push(...hit);
        continue;
      }
      if (started++ >= 2) continue; // spread first loads over a few polls
      void this.http
        .cached(key, AREA_REFRESH_MS, () => this.fetchArea(box), AREA_REFRESH_MS)
        .catch((err) => this.logger.warn(`area search: ${(err as Error).message}`));
    }
    return out;
  }

  private async fetchArea(box: { s: number; n: number; w: number; e: number }): Promise<AreaFlight[]> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.areaDay) {
      this.areaDay = today;
      this.areaCalls = 0;
    }
    if (this.areaCalls >= AREA_CAP) throw new Error('daily area-search budget reached');
    this.areaCalls++;
    const query = `-latlong "${box.s} ${box.w} ${box.n} ${box.e}"`;
    const res = await fetch(`${AEROAPI}/flights/search?query=${encodeURIComponent(query)}&max_pages=1`, {
      headers: { 'x-apikey': this.key!, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new UpstreamError(`${res.status} from aeroapi (search)`, res.status);
    const data = (await res.json()) as { flights?: any[] };
    const out: AreaFlight[] = [];
    for (const f of data.flights ?? []) {
      const p = f.last_position;
      if (!p || typeof p.latitude !== 'number') continue;
      out.push({
        callsign: (f.ident_icao ?? f.ident ?? '').toUpperCase(),
        identIata: f.ident_iata ?? null,
        type: f.aircraft_type ?? null,
        lat: p.latitude,
        lon: p.longitude,
        alt: typeof p.altitude === 'number' ? p.altitude * 100 : null,
        gs: p.groundspeed ?? null,
        heading: p.heading ?? null,
        at: Date.parse(p.timestamp) || Date.now(),
        updateType: p.update_type ?? null,
        origin: f.origin?.code_icao ?? f.origin?.code ?? null,
        destination: f.destination?.code_icao ?? f.destination?.code ?? null,
      });
    }
    this.logger.log(`Area search ${box.s},${box.w} → ${box.n},${box.e}: ${out.length} flights`);
    return out;
  }

  private groundDay = '';
  private groundCalls = 0;

  async airportGround(icao: string): Promise<{ landed: GroundFlight[]; departing: GroundFlight[]; error?: string }> {
    if (!this.key) return { landed: [], departing: [] };
    try {
      return await this.http.cached(`fa-ground:${icao}`, GROUND_REFRESH_MS, () => this.fetchGround(icao), GROUND_REFRESH_MS);
    } catch (err) {
      return { landed: [], departing: [], error: (err as Error).message };
    }
  }

  private async fetchGround(icao: string) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.groundDay) {
      this.groundDay = today;
      this.groundCalls = 0;
    }
    if (this.groundCalls + 2 > GROUND_CAP) throw new Error('daily airport-list budget reached');
    this.groundCalls += 2;
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';
    const now = Date.now();
    const get = async (path: string, key: string) => {
      const res = await fetch(`${AEROAPI}/airports/${encodeURIComponent(icao)}/flights/${path}`, {
        headers: { 'x-apikey': this.key!, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new UpstreamError(`${res.status} from aeroapi (${path.split('?')[0]})`, res.status);
      return ((await res.json()) as Record<string, any[]>)[key] ?? [];
    };
    const [arrivals, departures] = await Promise.all([
      get(`arrivals?type=Airline&start=${iso(now - 2 * 3600_000)}&max_pages=1`, 'arrivals'),
      get(`scheduled_departures?type=Airline&start=${iso(now - 30 * 60_000)}&end=${iso(now + 3 * 3600_000)}&max_pages=1`, 'scheduled_departures'),
    ]);
    const mins = (s: unknown) => (typeof s === 'number' ? Math.round(s / 60) : null);
    const other = (a: any) => (a ? { code: a.code_iata ?? a.code_icao ?? a.code ?? null, city: a.city ?? null, name: a.name ?? null } : null);
    const landed: GroundFlight[] = arrivals
      .filter((f) => (f.actual_on || f.actual_in) && !f.cancelled)
      .map((f) => ({
        ident: f.ident_icao ?? f.ident,
        identIata: f.ident_iata ?? null,
        operator: f.operator_iata ?? f.operator ?? null,
        otherAirport: other(f.origin),
        time: f.actual_in ?? f.actual_on,
        scheduledTime: f.scheduled_in ?? f.scheduled_on ?? null,
        delayMin: mins(f.arrival_delay),
        gate: f.gate_destination ?? null,
        terminal: f.terminal_destination ?? null,
        baggage: f.baggage_claim ?? null,
        aircraftType: f.aircraft_type ?? null,
        registration: f.registration ?? null,
        status: f.status ?? '',
      }))
      .sort((a, b) => Date.parse(b.time ?? '') - Date.parse(a.time ?? ''));
    const departing: GroundFlight[] = departures
      .filter((f) => !f.actual_off && !f.cancelled)
      .map((f) => ({
        ident: f.ident_icao ?? f.ident,
        identIata: f.ident_iata ?? null,
        operator: f.operator_iata ?? f.operator ?? null,
        otherAirport: other(f.destination),
        time: f.actual_out ?? f.estimated_out ?? f.scheduled_out ?? null,
        scheduledTime: f.scheduled_out ?? null,
        delayMin: mins(f.departure_delay),
        gate: f.gate_origin ?? null,
        terminal: f.terminal_origin ?? null,
        baggage: null,
        aircraftType: f.aircraft_type ?? null,
        registration: f.registration ?? null,
        status: f.status ?? '',
      }))
      .sort((a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? ''));
    return { landed, departing };
  }

  boardUsage() {
    return {
      callsToday: this.boardCalls,
      dailyCap: BOARD_CAP,
      refreshMinutes: BOARD_REFRESH_MS / 60_000,
      areaSearchesToday: this.areaCalls,
      areaDailyCap: AREA_CAP,
      positionsToday: this.posCalls,
      positionDailyCap: POSITION_CAP,
      groundListsToday: this.groundCalls,
      groundDailyCap: GROUND_CAP,
    };
  }

  private async aeroapi(cs: string): Promise<FlightStatus | null> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.callsToday = 0;
    }
    if (this.callsToday >= this.dailyCap) throw new Error('local rate-limit: daily AeroAPI budget reached');
    this.callsToday++;

    const start = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 19) + 'Z';
    const end = new Date(Date.now() + 30 * 3600_000).toISOString().slice(0, 19) + 'Z';
    const url = `${AEROAPI}/flights/${encodeURIComponent(cs)}?ident_type=designator&start=${start}&end=${end}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'x-apikey': this.key!, Accept: 'application/json' }, signal: ctrl.signal });
    } catch (err) {
      throw new UpstreamError(`aeroapi: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new UpstreamError('aeroapi: key rejected (check FLIGHTAWARE_AEROAPI_KEY)', res.status);
    if (!res.ok) throw new UpstreamError(`${res.status} from aeroapi`, res.status);
    const data = (await res.json()) as { flights?: any[] };
    const f = pickCurrent(data.flights ?? []);
    return f ? normalise(f) : null;
  }
}

const t = (s: unknown) => (typeof s === 'string' ? Date.parse(s) : NaN);

/** The leg the user most likely means: in the air now → next departure → most recent. */
function pickCurrent(flights: any[]): any | null {
  if (!flights.length) return null;
  const now = Date.now();
  const airborne = flights.find((f) => (f.actual_off || f.actual_out) && !f.actual_on && !f.actual_in && !f.cancelled);
  if (airborne) return airborne;
  const dep = (f: any) => t(f.estimated_out ?? f.scheduled_out ?? f.scheduled_off);
  const upcoming = flights
    .filter((f) => !f.actual_out && !f.actual_off && dep(f) > now - 3 * 3600_000)
    .sort((a, b) => dep(a) - dep(b))[0];
  const recent = flights
    .filter((f) => f.actual_on || f.actual_in)
    .sort((a, b) => t(b.actual_in ?? b.actual_on) - t(a.actual_in ?? a.actual_on))[0];
  // Prefer a flight that landed within the last 2 h over one departing many hours from now.
  if (recent && now - t(recent.actual_in ?? recent.actual_on) < 2 * 3600_000) {
    if (!upcoming || dep(upcoming) - now > 2 * 3600_000) return recent;
  }
  return upcoming ?? recent ?? flights[0];
}

function airport(a: any): StatusAirport | null {
  if (!a) return null;
  return { icao: a.code_icao ?? a.code ?? null, iata: a.code_iata ?? null, name: a.name ?? null, city: a.city ?? null, timezone: a.timezone ?? null };
}

function normalise(f: any): FlightStatus {
  const phase: FlightStatus['phase'] = f.cancelled
    ? 'cancelled'
    : f.diverted
      ? 'diverted'
      : f.actual_in
        ? 'arrived'
        : f.actual_on
          ? 'landed'
          : f.actual_off
            ? 'airborne'
            : f.actual_out
              ? 'taxiing'
              : 'scheduled';
  const min = (s: unknown) => (typeof s === 'number' ? Math.round(s / 60) : null);
  return {
    source: 'flightaware',
    hex: null,
    faFlightId: f.fa_flight_id ?? null,
    lastPosition: toPosition(f.last_position),
    ident: f.ident_icao ?? f.ident,
    identIata: f.ident_iata ?? null,
    status: f.status ?? '',
    phase,
    cancelled: !!f.cancelled,
    diverted: !!f.diverted,
    progressPercent: typeof f.progress_percent === 'number' ? f.progress_percent : null,
    origin: airport(f.origin),
    destination: airport(f.destination),
    aircraftType: f.aircraft_type ?? null,
    registration: f.registration ?? null,
    departureDelayMin: min(f.departure_delay),
    arrivalDelayMin: min(f.arrival_delay),
    gateOrigin: f.gate_origin ?? null,
    gateDestination: f.gate_destination ?? null,
    terminalOrigin: f.terminal_origin ?? null,
    terminalDestination: f.terminal_destination ?? null,
    baggageClaim: f.baggage_claim ?? null,
    times: {
      scheduledOut: f.scheduled_out ?? null,
      estimatedOut: f.estimated_out ?? null,
      actualOut: f.actual_out ?? null,
      scheduledOff: f.scheduled_off ?? null,
      estimatedOff: f.estimated_off ?? null,
      actualOff: f.actual_off ?? null,
      scheduledOn: f.scheduled_on ?? null,
      estimatedOn: f.estimated_on ?? null,
      actualOn: f.actual_on ?? null,
      scheduledIn: f.scheduled_in ?? null,
      estimatedIn: f.estimated_in ?? null,
      actualIn: f.actual_in ?? null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

function ago(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function toPosition(p: any): FlightStatus['lastPosition'] {
  if (!p || typeof p.latitude !== 'number') return null;
  return {
    lat: p.latitude,
    lon: p.longitude,
    alt: typeof p.altitude === 'number' ? p.altitude * 100 : null,
    gs: p.groundspeed ?? null,
    heading: p.heading ?? null,
    at: p.timestamp ?? new Date().toISOString(),
    updateType: p.update_type ?? null,
  };
}
