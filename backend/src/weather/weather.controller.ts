import { Controller, Get, Param, Query, ServiceUnavailableException } from '@nestjs/common';
import { WeatherService } from './weather.service';
import { num } from '../common/params';

@Controller('weather')
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}

  @Get()
  async current(@Query('lat') lat: string, @Query('lon') lon: string) {
    try {
      return await this.weather.current(num(lat, 'lat', -90, 90), num(lon, 'lon', -180, 180));
    } catch (err) {
      if ((err as any)?.status === 400) throw err;
      throw new ServiceUnavailableException('Weather temporarily unavailable');
    }
  }

  @Get('metar/:icao')
  async metar(@Param('icao') icao: string) {
    return { metar: await this.weather.metar(icao) };
  }
}
