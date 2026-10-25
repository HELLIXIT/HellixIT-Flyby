import { Injectable } from '@nestjs/common';
import { HttpCacheService, UpstreamError } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';
import { Airport, AirportsService } from '../airports/airports.service';
import { AIRLINES, AIRLINES_BY_ICAO } from './airlines';

export interface RouteInfo {
  callsign: string;
  callsignIata: string | null;
  airline: { name: string; icao: string | null; iata: string | null } | null;
  origin: Airport | null;
  destination: Airport | null;
  source: string;
}

export interface AircraftInfo {
  hex: string;
  registration: string | null;
  type: string | null;
  icaoType: string | null;
  manufacturer: string | null;
  owner: string | null;
  ownerCountry: string | null;
  source: string;
}

export interface Photo {
  thumbnail: string;
  large: string | null;
  link: string | null;
  photographer: string | null;
  source: string;
}

/** 404s are "not found" answers, not outages: return null so the chain moves on without tripping breakers. */
async function nullOn404<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return null;
    throw err;
  }
}

@Injectable()
export class InfoService {
  readonly routeChain: ProviderChain<[string], RouteInfo | null>;
  readonly aircraftChain: ProviderChain<[string], AircraftInfo | null>;
  readonly photoChain: ProviderChain<[string, string | null], Photo | null>;

  constructor(
    private readonly http: HttpCacheService,
    private readonly airports: AirportsService,
  ) {
    this.routeChain = new ProviderChain('route', [
      { name: 'adsbdb', run: (cs) => this.routeAdsbdb(cs) },
      { name: 'hexdb', run: (cs) => this.routeHexdb(cs) },
    ]);
    this.aircraftChain = new ProviderChain('aircraft', [
      { name: 'adsbdb', run: (hex) => this.aircraftAdsbdb(hex) },
      { name: 'hexdb', run: (hex) => this.aircraftHexdb(hex) },
    ]);
    this.photoChain = new ProviderChain('photo', [
      { name: 'planespotters', run: (hex, reg) => this.photoPlanespotters(hex, reg) },
      { name: 'hexdb', run: (hex) => this.photoHexdb(hex) },
    ]);
  }

  health() {
    return { route: this.routeChain.health(), aircraft: this.aircraftChain.health(), photo: this.photoChain.health() };
  }

  /** Route if already known (cached), without any network call. undefined = not looked up yet. */
  peekRoute(callsign: string): RouteInfo | null | undefined {
    return this.http.peek<RouteInfo | null>(`route:${callsign.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
  }

  route(callsign: string): Promise<RouteInfo | null> {
    const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.http.cached(`route:${cs}`, 6 * 3600_000, async () => (await this.routeChain.run(cs)) ?? null, 24 * 3600_000, 10 * 60_000).catch(
      () => null,
    );
  }

  aircraft(hex: string): Promise<AircraftInfo | null> {
    const h = hex.toLowerCase();
    return this.http.cached(`ac:${h}`, 24 * 3600_000, async () => (await this.aircraftChain.run(h)) ?? null, 5 * 60_000, 30 * 60_000).catch(() => null);
  }

  photo(hex: string, reg: string | null): Promise<Photo | null> {
    const h = hex.toLowerCase();
    return this.http.cached(`photo:${h}`, 24 * 3600_000, async () => (await this.photoChain.run(h, reg)) ?? null, 5 * 60_000, 30 * 60_000).catch(
      () => null,
    );
  }

  /** Convert a marketed flight number (BA123) into the ICAO callsign aircraft broadcast (BAW123). */
  async toIcaoCallsign(q: string): Promise<string | null> {
    const m = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(q);
    if (!m) return null;
    const route = await this.route(q);
    if (route?.callsign && route.callsign !== q) return route.callsign;
    const local = AIRLINES[m[1]];
    return local ? `${local[0]}${m[2]}` : null;
  }

  // ---------------------------------------------------------------- providers

  private airline(icao: string | null, fallback?: any) {
    if (fallback?.name) return { name: fallback.name, icao: fallback.icao ?? icao, iata: fallback.iata ?? null };
    const local = icao ? AIRLINES_BY_ICAO[icao] : undefined;
    return local ? { name: local.name, icao, iata: local.iata } : null;
  }

  private async routeAdsbdb(cs: string): Promise<RouteInfo | null> {
    const data = await nullOn404(this.http.getJson(`https://api.adsbdb.com/v0/callsign/${cs}`));
    const fr = data?.response?.flightroute;
    if (!fr) return null;
    const ap = (x: any): Airport | null =>
      !x
        ? null
        : (this.airports.get(x.icao_code) ?? {
            icao: x.icao_code,
            iata: x.iata_code ?? null,
            name: x.name,
            city: x.municipality ?? null,
            country: x.country_iso_name,
            countryName: x.country_name,
            lat: x.latitude,
            lon: x.longitude,
            elevation: x.elevation ?? null,
            size: 'medium',
            scheduled: true,
          });
    return {
      callsign: fr.callsign_icao ?? cs,
      callsignIata: fr.callsign_iata ?? null,
      airline: this.airline(fr.airline?.icao ?? cs.slice(0, 3), fr.airline),
      origin: ap(fr.origin),
      destination: ap(fr.destination),
      source: 'adsbdb',
    };
  }

  private async routeHexdb(cs: string): Promise<RouteInfo | null> {
    const text = await nullOn404(this.http.getText(`https://hexdb.io/callsign-route?callsign=${cs}`, 10_000));
    const m = text ? /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/.exec(text.trim()) : null;
    if (!m) return null;
    const icao = /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : null;
    const air = this.airline(icao);
    const num = cs.replace(/^[A-Z]{3}/, '');
    return {
      callsign: cs,
      callsignIata: air?.iata ? `${air.iata}${num}` : null,
      airline: air,
      origin: this.airports.get(m[1]),
      destination: this.airports.get(m[2]),
      source: 'hexdb',
    };
  }

  private async aircraftAdsbdb(hex: string): Promise<AircraftInfo | null> {
    const data = await nullOn404(this.http.getJson(`https://api.adsbdb.com/v0/aircraft/${hex}`));
    const a = data?.response?.aircraft;
    if (!a) return null;
    return {
      hex,
      registration: a.registration ?? null,
      type: a.type ?? null,
      icaoType: a.icao_type ?? null,
      manufacturer: a.manufacturer ?? null,
      owner: a.registered_owner ?? null,
      ownerCountry: a.registered_owner_country_name ?? null,
      source: 'adsbdb',
    };
  }

  private async aircraftHexdb(hex: string): Promise<AircraftInfo | null> {
    const a = await nullOn404(this.http.getJson(`https://hexdb.io/api/v1/aircraft/${hex}`));
    if (!a?.ModeS) return null;
    return {
      hex,
      registration: a.Registration ?? null,
      type: a.Type ?? null,
      icaoType: a.ICAOTypeCode ?? null,
      manufacturer: a.Manufacturer ?? null,
      owner: a.RegisteredOwners ?? null,
      ownerCountry: null,
      source: 'hexdb',
    };
  }

  private async photoPlanespotters(hex: string, reg: string | null): Promise<Photo | null> {
    const pick = (d: any): Photo | null => {
      const p = d?.photos?.[0];
      return p
        ? {
            thumbnail: p.thumbnail?.src,
            large: p.thumbnail_large?.src ?? null,
            link: p.link ?? null,
            photographer: p.photographer ?? null,
            source: 'planespotters',
          }
        : null;
    };
    const byHex = pick(await nullOn404(this.http.getJson(`https://api.planespotters.net/pub/photos/hex/${hex}`)));
    if (byHex || !reg) return byHex;
    return pick(await nullOn404(this.http.getJson(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`)));
  }

  private async photoHexdb(hex: string): Promise<Photo | null> {
    const [large, thumb] = await Promise.all([
      nullOn404(this.http.getText(`https://hexdb.io/hex-image?hex=${hex}`, 8_000)),
      nullOn404(this.http.getText(`https://hexdb.io/hex-image-thumb?hex=${hex}`, 8_000)),
    ]);
    const url = (s: string | null) => (s && /^https?:\/\//.test(s.trim()) ? s.trim() : null);
    const l = url(large);
    const t = url(thumb) ?? l;
    return t ? { thumbnail: t, large: l, link: null, photographer: null, source: 'hexdb' } : null;
  }
}
