import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { StatusService } from './status.service';
import { InfoService } from '../info/info.service';

@Controller('status')
export class StatusController {
  constructor(
    private readonly status: StatusService,
    private readonly info: InfoService,
  ) {}

  /** Schedule/gate/delay status for a callsign (null when no AeroAPI key is configured). */
  @Get(':callsign')
  async one(@Param('callsign') callsign: string) {
    const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cs.length < 3 || cs.length > 8) throw new BadRequestException('invalid callsign');
    const route = await this.info.route(cs);
    return { enabled: this.status.enabled, status: await this.status.status(cs, route) };
  }
}
