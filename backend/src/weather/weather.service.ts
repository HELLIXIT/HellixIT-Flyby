import { Injectable } from '@nestjs/common';
import { HttpCacheService } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';

export interface Weather {
  tempC: number | null;
  description: string;
  icon: string;
  windKt: number | null;
  windDir: number | null;
  gustKt: number | null;
  visibilityKm: number | null;
  cloudCover: number | null;
  isDay: boolean | null;
  timezone: string | null;
  utcOffsetSeconds: number;
  source: string;
}

export interface Metar {
  station: string;
  raw: string;
  observed: string | null;
  flightCategory: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  /** Plain-English summary of what the METAR means for flights. */
  summary: string;
  source: string;
}

const WMO: Record<number, [string, string]> = {
  0: ['Clear sky', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'], 99: ['Severe thunderstorm', '⛈️'],
};

const CATEGORY_TEXT: Record<string, string> = {
  VFR: 'Good flying weather — no weather delays expected.',
  MVFR: 'Somewhat reduced visibility or low clouds — minor delays possible.',
  IFR: 'Low clouds or poor visibility — instrument approaches in use, delays possible.',
  LIFR: 'Very low clouds or visibility — significant delays or diversions possible.',
};

@Injectable()
export class WeatherService {
  readonly currentChain: ProviderChain<[number, number], Weather>;
  readonly metarChain: ProviderChain<[string], Metar | null>;

  constructor(private readonly http: HttpCacheService) {
    this.currentChain = new ProviderChain('weather', [
      { name: 'open-meteo', run: (lat, lon) => this.openMeteo(lat, lon) },
      { name: 'met.no', run: (lat, lon) => this.metNo(lat, lon) },
    ]);
    this.metarChain = new ProviderChain('metar', [
      { name: 'aviationweather.gov', run: (id) => this.awc(id) },
      { name: 'vatsim-metar', run: (id) => this.vatsim(id) },
    ]);
  }

  health() {
    return { weather: this.currentChain.health(), metar: this.metarChain.health() };
  }

  current(lat: number, lon: number) {
    const key = `wx:${lat.toFixed(2)}:${lon.toFixed(2)}`;
    return this.http.cached(key, 10 * 60_000, () => this.currentChain.run(lat, lon), 3 * 3600_000);
  }

  metar(icao: string) {
    const id = icao.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return this.http
      .cached(`metar:${id}`, 10 * 60_000, async () => (await this.metarChain.run(id)) ?? null, 3 * 3600_000)
      .catch(() => null);
  }

  // ---------------------------------------------------------------- providers

  private async openMeteo(lat: number, lon: number): Promise<Weather> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,cloud_cover,is_day` +
      `&wind_speed_unit=kn&timezone=auto`;
    const d = await this.http.getJson(url);
    const c = d.current ?? {};
    const [description, icon] = WMO[c.weather_code] ?? ['Unknown', '🌡️'];
    return {
      tempC: c.temperature_2m ?? null,
      description,
      icon: c.is_day === 0 && icon === '☀️' ? '🌙' : icon,
      windKt: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null,
      windDir: c.wind_direction_10m ?? null,
      gustKt: c.wind_gusts_10m != null ? Math.round(c.wind_gusts_10m) : null,
      visibilityKm: c.visibility != null ? Math.round(c.visibility / 100) / 10 : null,
      cloudCover: c.cloud_cover ?? null,
      isDay: c.is_day == null ? null : c.is_day === 1,
      timezone: d.timezone ?? null,
      utcOffsetSeconds: d.utc_offset_seconds ?? Math.round(lon / 15) * 3600,
      source: 'open-meteo',
    };
  }

  private async metNo(lat: number, lon: number): Promise<Weather> {
    const d = await this.http.getJson(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`,
    );
    const ts = d.properties?.timeseries?.[0]?.data;
    if (!ts) throw new Error('met.no: no timeseries');
    const det = ts.instant?.details ?? {};
    const sym: string = ts.next_1_hours?.summary?.symbol_code ?? '';
    const map: [RegExp, string, string][] = [
      [/thunder/, 'Thunderstorm', '⛈️'], [/snow/, 'Snow', '🌨️'], [/sleet/, 'Sleet', '🌨️'],
      [/heavyrain/, 'Heavy rain', '🌧️'], [/rain/, 'Rain', '🌦️'], [/fog/, 'Fog', '🌫️'],
      [/cloudy/, 'Overcast', '☁️'], [/partlycloudy/, 'Partly cloudy', '⛅'], [/fair/, 'Mostly clear', '🌤️'],
      [/clearsky/, 'Clear sky', '☀️'],
    ];
    const hit = map.find(([re]) => re.test(sym));
    return {
      tempC: det.air_temperature ?? null,
      description: hit?.[1] ?? 'Unknown',
      icon: sym.endsWith('_night') && hit?.[2] === '☀️' ? '🌙' : (hit?.[2] ?? '🌡️'),
      windKt: det.wind_speed != null ? Math.round(det.wind_speed * 1.94384) : null,
      windDir: det.wind_from_direction ?? null,
      gustKt: null,
      visibilityKm: null,
      cloudCover: det.cloud_area_fraction ?? null,
      isDay: sym ? !sym.endsWith('_night') : null,
      timezone: null,
      // met.no has no timezone; approximate from longitude.
      utcOffsetSeconds: Math.round(lon / 15) * 3600,
      source: 'met.no',
    };
  }

  private async awc(id: string): Promise<Metar | null> {
    const list = await this.http.getJson<any[]>(`https://aviationweather.gov/api/data/metar?ids=${id}&format=json`);
    const m = Array.isArray(list) ? list[0] : null;
    if (!m?.rawOb) return null;
    const cat = (m.fltCat as Metar['flightCategory']) ?? decodeCategory(m.rawOb);
    return {
      station: id,
      raw: m.rawOb,
      observed: m.reportTime ?? null,
      flightCategory: cat,
      summary: cat ? CATEGORY_TEXT[cat] : 'Conditions unavailable.',
      source: 'aviationweather.gov',
    };
  }

  private async vatsim(id: string): Promise<Metar | null> {
    const raw = (await this.http.getText(`https://metar.vatsim.net/metar.php?id=${id}`, 8_000)).trim();
    if (!raw || !raw.startsWith(id)) return null;
    const cat = decodeCategory(raw);
    return {
      station: id,
      raw,
      observed: null,
      flightCategory: cat,
      summary: cat ? CATEGORY_TEXT[cat] : 'Conditions unavailable.',
      source: 'vatsim-metar',
    };
  }
}

/** Approximate FAA flight category from a raw METAR (ceiling + visibility). */
function decodeCategory(raw: string): Metar['flightCategory'] {
  let visSm: number | null = null;
  const sm = /\s(\d+)?\s?(\d\/\d)?SM\b/.exec(raw);
  if (sm) visSm = (sm[1] ? Number(sm[1]) : 0) + (sm[2] ? eval_frac(sm[2]) : 0);
  const m4 = /\s(\d{4})\s/.exec(raw);
  if (visSm === null && m4) visSm = Number(m4[1]) / 1609;
  if (/CAVOK/.test(raw)) visSm = 10;
  let ceilFt = Infinity;
  for (const c of raw.matchAll(/\b(BKN|OVC|VV)(\d{3})\b/g)) ceilFt = Math.min(ceilFt, Number(c[2]) * 100);
  if (visSm === null && ceilFt === Infinity) return null;
  const v = visSm ?? 10;
  if (ceilFt < 500 || v < 1) return 'LIFR';
  if (ceilFt < 1000 || v < 3) return 'IFR';
  if (ceilFt <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

function eval_frac(f: string) {
  const [a, b] = f.split('/').map(Number);
  return b ? a / b : 0;
}
