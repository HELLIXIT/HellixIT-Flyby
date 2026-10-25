import { Controller, Get } from '@nestjs/common';
import { StatusService } from '../status/status.service';

/**
 * Public runtime settings for the web app. Read at request time, so changing an env var
 * on Render only needs a restart — no rebuild of the frontend.
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly status: StatusService) {}

  @Get()
  config() {
    return {
      // CARTO basemap keys are used in browser tile URLs, so they are public by design.
      cartoApiKey: process.env.CARTO_API_KEY?.trim() || null,
      airplanesLiveEnabled: process.env.AIRPLANES_LIVE_ENABLED === 'true',
      // Schedules, delays, gates and estimated positions via FlightAware AeroAPI (optional key).
      flightStatusEnabled: this.status.enabled,
    };
  }
}
