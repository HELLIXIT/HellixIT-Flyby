import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { AirportsService } from './airports.service';
import { WeatherService } from '../weather/weather.service';
import { FlightsService } from '../flights/flights.service';
import { StatusService } from '../status/status.service';
import { num, optNum } from '../common/params';
import { angleDiff, bearingDeg, distanceNm } from '../common/geo';

@Controller('airports')
export class AirportsController {
  constructor(
    private readonly airports: AirportsService,
    private readonly weather: WeatherService,
    private readonly flights: FlightsService,
    private readonly status: StatusService,
  ) {}

  @Get('search')
  search(@Query('q') q = '') {
    return { airports: this.airports.search(q, 10) };
  }

  @Get('major')
  major() {
    return { airports: this.airports.major() };
  }

  @Get('nearby')
  nearby(@Query('lat') lat: string, @Query('lon') lon: string, @Query('radius') radius?: string) {
    return {
      airports: this.airports.nearby(num(lat, 'lat', -90, 90), num(lon, 'lon', -180, 180), optNum(radius, 'radius', 1, 500, 100), 10, true),
    };
  }

  /** Compact list for map markers: [iata, icao, name, lat, lon, size(L|M)]. */
  @Get('map')
  map() {
    return {
      airports: this.airports
        .forMap()
        .map((a) => [a.iata, a.icao, a.name, Math.round(a.lat * 1e4) / 1e4, Math.round(a.lon * 1e4) / 1e4, a.size === 'large' ? 'L' : 'M']),
    };
  }

  /**
   * Aircraft at the airport: live ones on the ground (receivers) plus, with a FlightAware key,
   * flights that landed recently and flights departing soon (with gates) from the schedule.
   */
  @Get(':code/ground')
  async ground(@Param('code') code: string) {
    const ap = this.airports.get(code);
    if (!ap) throw new NotFoundException(`Unknown airport ${code}`);
    const schedule = await this.status.airportGround(ap.icao);
    return { airport: ap, scheduleEnabled: this.status.enabled, ...schedule };
  }

  @Get(':code')
  async one(@Param('code') code: string) {
    const airport = this.airports.get(code);
    if (!airport) throw new NotFoundException(`Unknown airport ${code}`);
    const [weather, metar] = await Promise.all([
      this.weather.current(airport.lat, airport.lon).catch(() => null),
      this.weather.metar(airport.icao),
    ]);
    return { airport, weather, metar };
  }

  /**
   * Live arrivals/departures board derived from real-time positions around the airport
   * (no paid schedule API needed): classifies nearby traffic by flight phase.
   */
  @Get(':code/traffic')
  async traffic(@Param('code') code: string) {
    const ap = this.airports.get(code);
    if (!ap) throw new NotFoundException(`Unknown airport ${code}`);
    const R = 80;
    const dLat = R / 60;
    const dLon = R / (60 * Math.max(0.2, Math.cos((ap.lat * Math.PI) / 180)));
    const live = await this.flights.inBounds({ north: ap.lat + dLat, south: ap.lat - dLat, east: ap.lon + dLon, west: ap.lon - dLon });
    const elev = ap.elevation ?? 0;

    const arrivals: any[] = [];
    const departures: any[] = [];
    const onGround: any[] = [];
    for (const a of live.aircraft) {
      const dist = distanceNm(ap.lat, ap.lon, a.lat, a.lon);
      if (dist > R) continue;
      const toAirport = bearingDeg(a.lat, a.lon, ap.lat, ap.lon);
      const fromAirport = (toAirport + 180) % 360;
      const agl = (a.alt ?? 0) - elev;
      const row = { ...a, distanceNm: Math.round(dist * 10) / 10 };
      if (a.onGround || (agl < 300 && (a.gs ?? 0) < 60)) {
        if (dist < 4) onGround.push(row);
        continue;
      }
      const vr = a.vrate ?? 0;
      const heading = a.track ?? 0;
      const towards = angleDiff(heading, toAirport) < 60;
      const away = angleDiff(heading, fromAirport) < 70;
      if (towards && agl < 18000 && (vr < -200 || agl < 4000 || (agl < 12000 && dist < 40))) {
        const mins = a.gs && a.gs > 60 ? Math.round((dist / a.gs) * 60 + 3) : null;
        arrivals.push({ ...row, etaMinutes: mins });
      } else if (away && vr > 200 && agl < 25000 && dist < 60) {
        departures.push(row);
      }
    }
    arrivals.sort((x, y) => (x.etaMinutes ?? 999) - (y.etaMinutes ?? 999));
    departures.sort((x, y) => x.distanceNm - y.distanceNm);
    return { airport: ap, source: live.source, degraded: live.degraded, arrivals, departures, onGround };
  }
}
