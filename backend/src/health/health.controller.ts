import { Controller, Get } from '@nestjs/common';
import { FlightsService } from '../flights/flights.service';
import { InfoService } from '../info/info.service';
import { WeatherService } from '../weather/weather.service';
import { AirportsService } from '../airports/airports.service';
import { StatusService } from '../status/status.service';
import { SightingsService } from '../status/sightings.service';

@Controller('health')
export class HealthController {
  private readonly started = Date.now();

  constructor(
    private readonly flights: FlightsService,
    private readonly info: InfoService,
    private readonly weather: WeatherService,
    private readonly airports: AirportsService,
    private readonly status: StatusService,
    private readonly sightings: SightingsService,
  ) {}

  /** Always 200 while the process is up (Render health check); details show upstream provider state. */
  @Get()
  health() {
    const chains = { ...this.flights.health(), ...this.info.health(), ...this.weather.health(), 'airports-db': this.airports.chain.health(),
      ...(this.status.enabled ? { 'flight-status': this.status.chain.health() } : {}),
      'opensky-flights': this.sightings.chain.health(),
    };
    const degraded = Object.entries(chains)
      .filter(([, list]) => list.some((p) => p.state === 'open'))
      .map(([name]) => name);
    return {
      status: degraded.length ? 'degraded' : 'ok',
      uptimeSeconds: Math.round((Date.now() - this.started) / 1000),
      airports: this.airports.status(),
      flightStatus: this.status.usage(),
      estimates: this.sightings.stats(),
      degraded,
      providers: chains,
    };
  }
}
