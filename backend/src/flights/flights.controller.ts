import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { num } from '../common/params';
import { distanceNm } from '../common/geo';
import { FlightsService } from './flights.service';
import { InfoService, RouteInfo } from '../info/info.service';
import { AirportsService } from '../airports/airports.service';
import { LiveAircraft } from './aircraft.types';
import { FlightStatus, StatusService } from '../status/status.service';
import { EstimatesService } from './estimates.service';

@Controller('flights')
export class FlightsController {
  constructor(
    private readonly flights: FlightsService,
    private readonly info: InfoService,
    private readonly airports: AirportsService,
    private readonly status: StatusService,
    private readonly estimates: EstimatesService,
  ) {}

  /** All aircraft inside the map viewport. */
  @Get('bounds')
  bounds(@Query('n') n: string, @Query('s') s: string, @Query('e') e: string, @Query('w') w: string) {
    const north = num(n, 'n', -90, 90);
    const south = num(s, 's', -90, 90);
    const east = num(e, 'e', -540, 540);
    const west = num(w, 'w', -540, 540);
    if (north <= south || east <= west) throw new BadRequestException('invalid bounds');
    return this.flights.inBounds({ north, south, east, west });
  }

  /** Estimated positions of flights that recently went out of receiver coverage. */
  @Get('estimated')
  estimated(@Query('n') n: string, @Query('s') s: string, @Query('e') e: string, @Query('w') w: string) {
    const north = num(n, 'n', -90, 90);
    const south = num(s, 's', -90, 90);
    const east = num(e, 'e', -540, 540);
    const west = num(w, 'w', -540, 540);
    if (north <= south || east <= west) throw new BadRequestException('invalid bounds');
    return { aircraft: this.estimates.inBounds({ north, south, east, west }) };
  }

  @Get('alerts')
  async alerts() {
    return { aircraft: await this.flights.alerts().catch(() => []) };
  }

  @Get('military')
  async military() {
    return { aircraft: await this.flights.military().catch(() => []) };
  }

  /** Universal search: flight number (BA123 / BAW123), registration, ICAO hex, airport. */
  @Get('search')
  async search(@Query('q') q = '') {
    const raw = q.trim();
    const up = raw.toUpperCase().replace(/\s+/g, '');
    if (up.length < 2) return { flights: [], airports: [] };

    const tasks: Promise<LiveAircraft[]>[] = [];
    if (/^[0-9A-F]{6}$/.test(up)) tasks.push(this.flights.byHex(up));
    if (/^[A-Z0-9]{3,8}$/.test(up)) tasks.push(this.flights.byCallsign(up));
    if (/^[A-Z0-9]{1,3}-?[A-Z0-9]{1,6}$/.test(up) && up.length >= 3) tasks.push(this.flights.byRegistration(up));
    const icao = await this.info.toIcaoCallsign(up).catch(() => null);
    if (icao && icao !== up) tasks.push(this.flights.byCallsign(icao));

    const results = await Promise.allSettled(tasks);
    const seen = new Set<string>();
    const flights: LiveAircraft[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const a of r.value) if (!seen.has(a.hex)) seen.add(a.hex) && flights.push(a);
    }

    // A real, scheduled flight that no receiver network can see right now (e.g. over the
    // ocean): say so, instead of "no results", so the user can be notified once it appears.
    const callsign = icao ?? (/^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(up) ? up : null);
    let knownFlight: { callsign: string; flightNumber: string; route: RouteInfo; status: FlightStatus | null } | null = null;
    if (callsign && !flights.some((a) => a.callsign === callsign)) {
      const route = await this.info.route(callsign);
      const status = await this.status.status(callsign, route);
      // The estimate may know the aircraft's hex: it might be visible on a network under no/another callsign.
      if (status?.hex) {
        const live = (await this.flights.byHex(status.hex).catch(() => []))[0];
        if (live) return { flights: [live, ...flights].slice(0, 10), airports: this.airports.search(raw, 6), resolvedCallsign: icao, knownFlight: null };
      }
      if (route?.origin && route.destination) {
        knownFlight = { callsign, flightNumber: route.callsignIata ?? status?.identIata ?? up, route, status };
      } else if (status) {
        // Route DBs don't know it, but the schedule source does: build the route from it.
        const ap = (a: FlightStatus['origin']) => (a?.icao ? this.airports.get(a.icao) : null) ?? (a?.iata ? this.airports.get(a.iata) : null);
        const origin = ap(status.origin);
        const destination = ap(status.destination);
        if (origin && destination) {
          knownFlight = {
            callsign,
            flightNumber: status.identIata ?? up,
            route: { callsign, callsignIata: status.identIata, airline: null, origin, destination, source: 'flightaware' },
            status,
          };
        }
      }
    }
    return { flights: flights.slice(0, 10), airports: this.airports.search(raw, 6), resolvedCallsign: icao, knownFlight };
  }

  /** Live aircraft currently using a callsign (used to pick up watched flights once visible). */
  @Get('callsign/:cs')
  async byCallsign(@Param('cs') cs: string) {
    const c = cs.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 3 || c.length > 8) throw new BadRequestException('invalid callsign');
    const list = await this.flights.byCallsign(c).catch(() => []);
    return { aircraft: list.sort((a, b) => a.seen - b.seen)[0] ?? null };
  }

  @Get(':hex')
  async one(@Param('hex') hex: string) {
    if (!/^~?[0-9a-fA-F]{6}$/.test(hex)) throw new BadRequestException('invalid hex');
    const list = await this.flights.byHex(hex).catch(() => []);
    return { aircraft: list[0] ?? null };
  }

  /** Everything the flight panel needs in one round trip. */
  @Get(':hex/details')
  async details(@Param('hex') hex: string, @Query('callsign') callsignHint?: string) {
    if (!/^~?[0-9a-fA-F]{6}$/.test(hex)) throw new BadRequestException('invalid hex');
    const live = (await this.flights.byHex(hex).catch(() => []))[0] ?? null;
    const callsign = live?.callsign ?? callsignHint ?? null;
    const [route, aircraft, photo] = await Promise.all([
      callsign ? this.info.route(callsign) : Promise.resolve(null),
      this.info.aircraft(hex),
      this.info.photo(hex, live?.reg ?? null),
    ]);
    return { live, route, routeConfidence: confidence(live, route), aircraft, photo };
  }
}

/**
 * Route databases are crowd-sourced and callsigns get reused, so sanity-check that the
 * aircraft is plausibly between origin and destination before presenting the route as fact.
 */
function confidence(a: LiveAircraft | null, r: RouteInfo | null): 'high' | 'low' | null {
  if (!r?.origin || !r.destination) return null;
  if (!a) return 'high';
  const direct = distanceNm(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon);
  const via =
    distanceNm(r.origin.lat, r.origin.lon, a.lat, a.lon) + distanceNm(a.lat, a.lon, r.destination.lat, r.destination.lon);
  return via <= direct * 1.3 + 150 ? 'high' : 'low';
}
