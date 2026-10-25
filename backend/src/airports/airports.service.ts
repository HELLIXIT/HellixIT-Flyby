import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpCacheService } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';
import { distanceNm } from '../common/geo';

export interface Airport {
  icao: string;
  iata: string | null;
  name: string;
  city: string | null;
  country: string;
  countryName: string;
  lat: number;
  lon: number;
  elevation: number | null;
  size: 'large' | 'medium' | 'small';
  scheduled: boolean;
}

type Row = [string, string | null, string, string | null, string, number, number, number | null, 'L' | 'M' | 'S', 0 | 1];

const MIRRORS = [
  { name: 'ourairports', base: 'https://davidmegginson.github.io/ourairports-data' },
  { name: 'ourairports-github', base: 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main' },
];

/**
 * Airport database (OurAirports, public domain).
 * Boots instantly from a bundled snapshot, then refreshes from the network
 * (primary site → GitHub mirror). If both mirrors fail the snapshot keeps serving.
 */
@Injectable()
export class AirportsService implements OnModuleInit {
  private readonly logger = new Logger(AirportsService.name);
  private airports: Airport[] = [];
  private byCode = new Map<string, Airport>();
  private loadedFrom = 'none';
  private loadedAt = 0;
  readonly chain: ProviderChain<[], { airports: Row[]; countries: Record<string, string> }>;

  constructor(private readonly http: HttpCacheService) {
    this.chain = new ProviderChain(
      'airports-db',
      MIRRORS.map((m) => ({ name: m.name, run: () => this.download(m.base) })),
      { threshold: 1, cooldownMs: 10 * 60_000 },
    );
  }

  onModuleInit() {
    this.loadSnapshot();
    if (process.env.AIRPORTS_REFRESH !== 'false') {
      // Don't block boot (Render health checks) on a 12 MB download.
      setTimeout(() => void this.refresh(), 5_000).unref();
      setInterval(() => void this.refresh(), 7 * 24 * 3600_000).unref();
    }
  }

  status() {
    return { count: this.airports.length, source: this.loadedFrom, loadedAt: new Date(this.loadedAt).toISOString() };
  }

  get(code: string): Airport | null {
    return this.byCode.get(code.toUpperCase()) ?? null;
  }

  search(q: string, limit = 8): Airport[] {
    const query = q.trim().toLowerCase();
    if (query.length < 2) return [];
    const up = query.toUpperCase();
    const exact = this.byCode.get(up);
    const scored: { a: Airport; s: number }[] = [];
    for (const a of this.airports) {
      if (a === exact) continue;
      let s = 0;
      const name = a.name.toLowerCase();
      const city = (a.city ?? '').toLowerCase();
      if (a.iata?.toLowerCase().startsWith(query) || a.icao.toLowerCase().startsWith(query)) s = 80;
      else if (city.startsWith(query)) s = 60;
      else if (name.startsWith(query)) s = 50;
      else if (city.includes(query) || name.includes(query)) s = 30;
      else if (a.countryName.toLowerCase().startsWith(query) && a.size === 'large') s = 10;
      if (!s) continue;
      s += a.size === 'large' ? 15 : a.size === 'medium' ? 5 : 0;
      if (a.scheduled) s += 5;
      scored.push({ a, s });
    }
    scored.sort((x, y) => y.s - x.s);
    const list = scored.slice(0, limit).map((x) => x.a);
    return exact ? [exact, ...list.slice(0, limit - 1)] : list;
  }

  nearby(lat: number, lon: number, radiusNm = 100, limit = 10, onlyScheduled = false): (Airport & { distanceNm: number })[] {
    const dLat = radiusNm / 60;
    const out: (Airport & { distanceNm: number })[] = [];
    for (const a of this.airports) {
      if (Math.abs(a.lat - lat) > dLat) continue;
      if (onlyScheduled && !a.scheduled) continue;
      const d = distanceNm(lat, lon, a.lat, a.lon);
      if (d <= radiusNm) out.push({ ...a, distanceNm: Math.round(d * 10) / 10 });
    }
    return out.sort((x, y) => x.distanceNm - y.distanceNm).slice(0, limit);
  }

  /** Airports with scheduled service large enough to show on the map overview. */
  major(): Airport[] {
    return this.airports.filter((a) => a.size === 'large' && a.iata);
  }

  /** Airports worth marking on the map: large + medium with an IATA code and scheduled service. */
  forMap(): Airport[] {
    return this.airports.filter((a) => a.iata && a.scheduled && (a.size === 'large' || a.size === 'medium'));
  }

  // ---------------------------------------------------------------- loading

  private loadSnapshot() {
    try {
      const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', 'data', 'airports.snapshot.json'), 'utf8'));
      this.apply(raw.airports, raw.countries, 'bundled-snapshot');
    } catch (err) {
      this.logger.error(`Could not load bundled airport snapshot: ${(err as Error).message}`);
    }
  }

  private async refresh() {
    try {
      const { value, source } = await this.chain.runWithSource();
      if (value.airports.length > 1000) this.apply(value.airports, value.countries, source);
    } catch (err) {
      this.logger.warn(`Airport refresh failed, keeping ${this.loadedFrom}: ${(err as Error).message}`);
    }
  }

  private apply(rows: Row[], countries: Record<string, string>, source: string) {
    const list: Airport[] = rows.map((r) => ({
      icao: r[0],
      iata: r[1],
      name: r[2],
      city: r[3],
      country: r[4],
      countryName: countries[r[4]] ?? r[4],
      lat: r[5],
      lon: r[6],
      elevation: r[7],
      size: r[8] === 'L' ? 'large' : r[8] === 'M' ? 'medium' : 'small',
      scheduled: r[9] === 1,
    }));
    const map = new Map<string, Airport>();
    // Prefer larger airports when codes collide.
    const rank = { large: 0, medium: 1, small: 2 } as const;
    for (const a of [...list].sort((x, y) => rank[x.size] - rank[y.size])) {
      if (!map.has(a.icao)) map.set(a.icao, a);
      if (a.iata && !map.has(a.iata)) map.set(a.iata, a);
    }
    this.airports = list;
    this.byCode = map;
    this.loadedFrom = source;
    this.loadedAt = Date.now();
    this.logger.log(`Loaded ${list.length} airports from ${source}`);
  }

  private async download(base: string) {
    const [airportsCsv, countriesCsv] = await Promise.all([
      this.http.getText(`${base}/airports.csv`, 60_000),
      this.http.getText(`${base}/countries.csv`, 30_000),
    ]);
    const countries: Record<string, string> = {};
    const cRows = parseCsv(countriesCsv);
    const ch = cRows.shift() ?? [];
    const ci = (k: string) => ch.indexOf(k);
    for (const r of cRows) countries[r[ci('code')]] = r[ci('name')];

    const rows = parseCsv(airportsCsv);
    const h = rows.shift() ?? [];
    const i = (k: string) => h.indexOf(k);
    const [iType, iName, iLat, iLon, iElev, iCountry, iCity, iSched, iIcao, iIata, iGps, iIdent] = [
      'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'iso_country', 'municipality',
      'scheduled_service', 'icao_code', 'iata_code', 'gps_code', 'ident',
    ].map(i);
    if (iLat < 0 || iIata < 0) throw new Error('unexpected airports.csv header');

    const out: Row[] = [];
    for (const r of rows) {
      const t = r[iType];
      const keep =
        t === 'large_airport' || t === 'medium_airport' || (t === 'small_airport' && r[iIata] && r[iSched] === 'yes');
      if (!keep) continue;
      const lat = Number(r[iLat]);
      const lon = Number(r[iLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push([
        r[iIcao] || r[iGps] || r[iIdent],
        r[iIata] || null,
        r[iName],
        r[iCity] || null,
        r[iCountry],
        lat,
        lon,
        r[iElev] ? Math.round(Number(r[iElev])) : null,
        t === 'large_airport' ? 'L' : t === 'medium_airport' ? 'M' : 'S',
        r[iSched] === 'yes' ? 1 : 0,
      ]);
    }
    return { airports: out, countries };
  }
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
