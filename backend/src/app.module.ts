import { Global, Module } from '@nestjs/common';
import { HttpCacheService } from './common/http-cache.service';
import { FlightsService } from './flights/flights.service';
import { FlightsController } from './flights/flights.controller';
import { InfoService } from './info/info.service';
import { AirportsService } from './airports/airports.service';
import { AirportsController } from './airports/airports.controller';
import { WeatherService } from './weather/weather.service';
import { WeatherController } from './weather/weather.controller';
import { HealthController } from './health/health.controller';
import { ConfigController } from './config/config.controller';
import { StatusService } from './status/status.service';
import { SightingsService } from './status/sightings.service';
import { EstimatesService } from './flights/estimates.service';
import { StatusController } from './status/status.controller';

@Global()
@Module({
  controllers: [FlightsController, AirportsController, WeatherController, HealthController, ConfigController, StatusController],
  providers: [HttpCacheService, FlightsService, InfoService, AirportsService, WeatherService, StatusService, SightingsService, EstimatesService],
})
export class AppModule {}
