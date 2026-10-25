import { Injectable, Logger } from '@nestjs/common';
import { HttpCacheService } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';
import { SightingsService } from '../status/sightings.service';
import { LiveAircraft } from './aircraft.types';

const OPENSKY = 'https://opensky-network.org/api';

/** Fixed global grid so overlapping viewports from many users share upstream cache entries. */
const CELL_DEG = 5;
const MAX_CELLS = 16;
/** How long a live-position response is reused (keeps us well inside free-tier rate limits). */
const CACHE_MS = Number(process.env.LIVE_CACHE_MS ?? 5_000);
/** Areas with fewer aircraft than this from the community feeds get topped up from OpenSky. */
const SPARSE = 8;
const FILL_MAX_PER_DAY = Number(process.env.OPENSKY_FILL_MAX_PER_DAY ?? 1500);
/** readsb "re-api" endpoint for whole-network and box queries. Set LIVE_BULK_URL= (empty) to disable. */
const BULK_URL = process.env.LIVE_BULK_URL ?? 'https://re-api.adsb.lol/';

type BulkQuery = { kind: 'all' } | { kind: 'box'; south: number; north: number; west: number; east: number };

/**
 * Normalise a viewport into 1–2 boxes within ±180° (split at the antimeridian), rounded
 * outwards to 0.5° so nearby viewports share cache entries.
 */
function splitBox(b: { north: number; south: number; east: number; west: number }) {
  const r = (x: number, up: boolean) => (up ? Math.ceil(x * 2) : Math.floor(x * 2)) / 2;
  const south = Math.max(-90, r(b.south, false));
  const north = Math.min(90, r(b.north, true));
  if (b.east - b.west >= 360) return [{ south, north, west: -180, east: 180 }];
  let west = b.west;
  let east = b.east;
  while (west < -180) {
    west += 360;
    east += 360;
  }
  while (west >= 180) {
    west -= 360;
    east -= 360;
  }
  if (east <= 180) return [{ south, north, west: r(west, false), east: Math.min(180, r(east, true)) }];
  return [
    { south, north, west: r(west, false), east: 180 },
    { south, north, west: -180, east: r(east - 360, true) },
  ];
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

type LookupKind = 'hex' | 'callsign' | 'reg' | 'sqk' | 'mil';

/**
 * readsb-compatible community feeds. They share the same JSON schema, so any of them can
 * stand in for another. Order = preference; override with ADSB_PROVIDERS="adsbfi,adsblol".
 */
interface ReadsbFeed {
  name: string;
  point: (lat: number, lon: number, nm: number) => string;
  lookup: (kind: LookupKind, v: string) => string;
  minIntervalMs?: number;
}

const FEEDS: Record<string, ReadsbFeed> = {
  adsblol: {
    name: 'adsb.lol',
    point: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
    lookup: (k, v) => `https://api.adsb.lol/v2/${k === 'mil' ? 'mil' : `${k}/${v}`}`,
    minIntervalMs: Number(process.env.ADSBLOL_MIN_INTERVAL_MS ?? 400),
  },
  adsbfi: {
    name: 'adsb.fi',
    point: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    lookup: (k, v) =>
      `https://opendata.adsb.fi/api/v2/${k === 'mil' ? 'mil' : `${k === 'reg' ? 'registration' : k}/${v}`}`,
    minIntervalMs: 1_100, // documented limit: 1 request / second
  },
  airplaneslive: {
    name: 'airplanes.live',
    point: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
    lookup: (k, v) => `https://api.airplanes.live/v2/${k === 'mil' ? 'mil' : `${k}/${v}`}`,
    minIntervalMs: 1_100,
  },
};

function feedOrder(): ReadsbFeed[] {
  // airplanes.live requires prior approval, so it is opt-in.
  const def = process.env.AIRPLANES_LIVE_ENABLED === 'true' ? 'adsblol,adsbfi,airplaneslive' : 'adsblol,adsbfi';
  return (process.env.ADSB_PROVIDERS ?? def)
    .split(',')
    .map((s) => FEEDS[s.trim().toLowerCase()])
    .filter(Boolean);
}

/**
 * Only hex lookups fall through to the next network on "not found" (coverage differs per
 * network). For callsign/registration searches an empty answer is final, keeping search fast.
 */
const isEmpty = (r: LiveAircraft[], kind: LookupKind) => kind === 'hex' && (r.length === 0 || r.every(isStale));

/** A report at the edge of coverage: old position and/or missing altitude & speed. */
const isStale = (a: LiveAircraft) => a.seen > 30 || (a.alt === null && a.gs === null);
const freshest = (r: LiveAircraft[]) => Math.min(...r.map((a) => (isStale(a) ? a.seen + 1000 : a.seen)), Infinity);

@Injectable()
export class FlightsService {
  private readonly logger = new Logger(FlightsService.name);
  readonly pointChain: ProviderChain<[number, number, number], LiveAircraft[]>;
  readonly lookupChain: ProviderChain<[LookupKind, string], LiveAircraft[]>;
  /** Whole-network / any-size-box queries (readsb "re-api"): one request per viewport. */
  readonly bulkChain: ProviderChain<[BulkQuery], LiveAircraft[]>;
  /** Same feeds as lookupChain, but queried in parallel (runAll) for searches. */
  readonly searchChain: ProviderChain<[LookupKind, string], LiveAircraft[]>;
  /** OpenSky's worldwide snapshot — a third, independent network, used as a callsign index. */
  readonly openSkyGlobal: ProviderChain<[], LiveAircraft[]>;
  /** OpenSky as a coverage supplement for sparse areas (see withFill). */
  readonly fillChain: ProviderChain<[number, number, number], LiveAircraft[]>;
  private fillDay = '';
  private fillCalls = 0;

  constructor(
    private readonly http: HttpCacheService,
    private readonly sightings: SightingsService,
  ) {
    const feeds = feedOrder();
    this.pointChain = new ProviderChain('live-area', [
      ...feeds.map((f) => ({
        name: f.name,
        minIntervalMs: f.minIntervalMs,
        run: (lat: number, lon: number, nm: number) => this.readsb(f.point(lat, lon, nm)),
      })),
      // Last resort: OpenSky anonymous API (slower refresh, fewer fields, daily credit limits).
      { name: 'opensky', minIntervalMs: 2_000, run: (lat, lon, nm) => this.openSkyPoint(lat, lon, nm) },
    ]);
    this.bulkChain = new ProviderChain(
      'live-bulk',
      BULK_URL
        ? [
            {
              name: 're-api.adsb.lol',
              minIntervalMs: 1_000,
              run: (q: BulkQuery) =>
                this.readsb(q.kind === 'all' ? `${BULK_URL}?all_with_pos` : `${BULK_URL}?box=${q.south},${q.north},${q.west},${q.east}`, 30_000),
            },
          ]
        : [],
      { threshold: 2, cooldownMs: 60_000, maxCooldownMs: 15 * 60_000 },
    );
    this.lookupChain = new ProviderChain('lookup', [
      ...feeds.map((f) => ({
        name: f.name,
        minIntervalMs: f.minIntervalMs,
        isMiss: isEmpty,
        run: (k: LookupKind, v: string) => this.readsb(f.lookup(k, v)),
      })),
      {
        name: 'opensky',
        minIntervalMs: 2_000,
        isMiss: (r: LiveAircraft[]) => r.length === 0 || r.every(isStale),
        // Cached so polling a selected aircraft doesn't spend OpenSky's daily quota every few seconds.
        run: async (k: LookupKind, v: string) => (k === 'hex' ? this.http.cached(`os-hex:${v}`, 20_000, () => this.openSky(`icao24=${v}`)) : []),
      },
    ], { betterMiss: (a, b) => a.length > 0 && (b.length === 0 || freshest(a) < freshest(b)) });
    this.searchChain = new ProviderChain(
      'search',
      feeds.map((f) => ({
        name: f.name,
        minIntervalMs: f.minIntervalMs,
        run: (k: LookupKind, v: string) => this.readsb(f.lookup(k, v)),
      })),
    );
    // Anonymous OpenSky allows ~100 global snapshots/day, so it is fetched only on demand
    // (when the community feeds miss) and cached.
    this.fillChain = new ProviderChain(
      'opensky-fill',
      [
        {
          name: 'opensky',
          run: (lat: number, lon: number, nm: number) => {
            const today = new Date().toISOString().slice(0, 10);
            if (today !== this.fillDay) {
              this.fillDay = today;
              this.fillCalls = 0;
            }
            if (this.fillCalls >= FILL_MAX_PER_DAY) throw new Error('local rate-limit: daily OpenSky fill budget reached');
            this.fillCalls++;
            return this.openSkyPoint(lat, lon, nm);
          },
        },
      ],
      { threshold: 2, cooldownMs: 5 * 60_000, maxCooldownMs: 60 * 60_000 },
    );
    this.openSkyGlobal = new ProviderChain('opensky-global', [{ name: 'opensky', run: () => this.openSky('') }], {
      threshold: 1,
      cooldownMs: 5 * 60_000,
      maxCooldownMs: 30 * 60_000,
    });
  }

  health() {
    return {
      ...(BULK_URL ? { 'live-bulk': this.bulkChain.health() } : {}),
      'live-area': this.pointChain.health(),
      lookup: this.lookupChain.health(),
      search: this.searchChain.health(),
      'opensky-global': this.openSkyGlobal.health(),
      ...(this.fillEnabled() ? { 'opensky-fill': this.fillChain.health() } : {}),
    };
  }

  async inBounds(b: Bounds) {
    const bulk = BULK_URL ? await this.bulkBounds(b).catch((err) => {
      this.logger.warn(`bulk query failed, using regional queries: ${(err as Error).message}`);
      return null;
    }) : null;
    if (bulk) return bulk;
    return this.regionalBounds(b);
  }

  /**
   * One request per viewport: the whole-network snapshot for wide views (shared by every
   * user, 15 s), or a single box query for smaller ones. Thin areas are topped up from OpenSky.
   */
  private async bulkBounds(b: Bounds) {
    const wide = b.east - b.west > 30 || b.north - b.south > 25;
    let list: LiveAircraft[];
    if (wide) {
      list = await this.http.cached('bulk:all', 15_000, async () => {
        const r = await this.bulkChain.run({ kind: 'all' });
        this.sightings.noteScan({ kind: 'world' });
        return r;
      }, 2 * 60_000);
    } else {
      list = [];
      for (const box of splitBox(b)) {
        const key = `bulk:${box.south}:${box.north}:${box.west}:${box.east}`;
        list.push(
          ...(await this.http.cached(key, CACHE_MS, async () => {
            const r = await this.bulkChain.run({ kind: 'box', ...box });
            this.sightings.noteScan({ kind: 'box', ...box });
            return r;
          })),
        );
      }
    }
    let aircraft = list.filter((a) => this.inside(a, b));
    let source = 're-api.adsb.lol';
    // Thin coverage (e.g. Sri Lanka): also ask OpenSky for small views.
    const small = !wide ? this.smallViewQuery(b) : null;
    if (small && aircraft.length < SPARSE && this.fillEnabled()) {
      const extra = await this.http
        .cached(`fill:pt:${small.lat}:${small.lon}:${small.nm}`, 60_000, () => this.fillChain.run(small.lat, small.lon, small.nm), 5 * 60_000)
        .catch(() => [] as LiveAircraft[]);
      const have = new Set(aircraft.map((a) => a.hex));
      const add = extra.filter((a) => !have.has(a.hex) && this.inside(a, b));
      if (add.length) {
        aircraft = [...aircraft, ...add];
        source += ' + opensky';
      }
    }
    return { now: Date.now(), source, degraded: false, total: aircraft.length, truncated: false, aircraft };
  }

  private async regionalBounds(b: Bounds) {
    const small = this.smallViewQuery(b);
    if (small) {
      try {
        const r = await this.withFill(
          `pt:${small.lat}:${small.lon}:${small.nm}`,
          small.lat,
          small.lon,
          small.nm,
        );
        const aircraft = r.value.filter((a) => this.inside(a, b));
        return {
          now: Date.now(),
          source: r.source,
          degraded: r.source !== feedOrder()[0]?.name,
          total: aircraft.length,
          truncated: false,
          aircraft,
        };
      } catch (err) {
        this.logger.error(`point query failed: ${(err as Error).message}`);
        return { now: Date.now(), source: 'none', degraded: true, total: 0, truncated: false, aircraft: [] as LiveAircraft[] };
      }
    }
    const cells = this.cellsFor(b);
    const truncated = cells.length > MAX_CELLS;
    // When zoomed far out, prioritise cells nearest the viewport centre.
    const cLat = (b.north + b.south) / 2;
    const cLon = (b.east + b.west) / 2;
    const chosen = cells
      .sort((a, c) => Math.hypot(a.lat - cLat, a.lon - cLon) - Math.hypot(c.lat - cLat, c.lon - cLon))
      .slice(0, MAX_CELLS);

    const sources = new Set<string>();
    let failedCells = 0;
    const results = await this.mapLimit(chosen, 4, async (c) => {
      try {
        const r = await this.cell(c.lat, c.lon);
        sources.add(r.source);
        return r.value;
      } catch (err) {
        failedCells++;
        this.logger.error(`cell ${c.lat},${c.lon}: ${(err as Error).message}`);
        return [] as LiveAircraft[];
      }
    });

    const seen = new Set<string>();
    const aircraft: LiveAircraft[] = [];
    for (const list of results) {
      for (const a of list) {
        if (seen.has(a.hex)) continue;
        if (!this.inside(a, b)) continue;
        seen.add(a.hex);
        aircraft.push(a);
      }
    }
    return {
      now: Date.now(),
      source: [...sources].join(', ') || 'none',
      degraded: failedCells > 0 || [...sources].some((s) => s !== feedOrder()[0]?.name),
      total: aircraft.length,
      truncated,
      aircraft,
    };
  }

  byHex(hex: string) {
    const h = hex.toLowerCase().replace(/[^0-9a-f~]/g, '');
    return this.lookup('hex', h, 3_000);
  }

  /**
   * Callsign search across every network: all readsb feeds in parallel (each has its own
   * receivers), then OpenSky's global snapshot if none of them can see it.
   */
  byCallsign(cs: string): Promise<LiveAircraft[]> {
    const c = cs.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.http.cached(`cs-all:${c}`, 5_000, async () => {
      const found = await this.everywhere('callsign', c);
      if (found.length) return found;
      const global = await this.openSkyGlobalSnapshot().catch(() => [] as LiveAircraft[]);
      return global.filter((a) => a.callsign === c);
    });
  }

  byRegistration(reg: string): Promise<LiveAircraft[]> {
    const r = reg.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    return this.http.cached(`reg-all:${r}`, 5_000, () => this.everywhere('reg', r));
  }

  private async everywhere(kind: LookupKind, v: string): Promise<LiveAircraft[]> {
    const answers = await this.searchChain.runAll(kind, v);
    const byHex = new Map<string, LiveAircraft>();
    for (const { value } of answers) {
      for (const a of value) {
        const prev = byHex.get(a.hex);
        // Keep the freshest report when several networks see the same aircraft.
        if (!prev || a.seen < prev.seen) byHex.set(a.hex, a);
      }
    }
    return [...byHex.values()];
  }

  private openSkyGlobalSnapshot() {
    return this.http.cached('opensky:global', 90_000, () => this.openSkyGlobal.run(), 10 * 60_000);
  }

  /** Aircraft squawking emergency codes worldwide. */
  alerts() {
    return this.http.cached('alerts', 20_000, async () => {
      const codes: Record<string, string> = {
        '7700': 'General emergency',
        '7600': 'Radio failure',
        '7500': 'Unlawful interference',
      };
      const lists = await Promise.all(
        Object.keys(codes).map((sq) => this.lookup('sqk', sq, 20_000).catch(() => [] as LiveAircraft[])),
      );
      return lists
        .flat()
        .map((a) => ({ ...a, alertReason: codes[a.squawk ?? ''] ?? a.emergency ?? 'Emergency' }));
    });
  }

  military() {
    return this.lookup('mil', '', 20_000);
  }

  // ---------------------------------------------------------------- internals

  private lookup(kind: LookupKind, v: string, ttl: number): Promise<LiveAircraft[]> {
    return this.http.cached(`${kind}:${v}`, ttl, () => this.lookupChain.run(kind, v));
  }

  /**
   * Zoomed-in views fit in one upstream request: snap the centre to a 0.5° grid and the
   * radius to a few buckets so nearby users/pans share the same cache entry.
   */
  private smallViewQuery(b: Bounds) {
    if (b.east - b.west > 20) return null;
    const cLat = (b.north + b.south) / 2;
    const cLon = (b.east + b.west) / 2;
    const lat = Math.round(cLat * 2) / 2;
    const lonRaw = Math.round(cLon * 2) / 2;
    const lon = ((((lonRaw + 180) % 360) + 360) % 360) - 180;
    const cos = Math.cos((cLat * Math.PI) / 180);
    const halfH = ((b.north - b.south) / 2) * 60;
    const halfW = ((b.east - b.west) / 2) * 60 * cos;
    const snapErr = Math.hypot(Math.abs(lat - cLat) * 60, Math.abs(lonRaw - cLon) * 60 * cos);
    const need = Math.hypot(halfH, halfW) + snapErr + 5;
    const nm = [40, 80, 120, 180, 250].find((r) => r >= need);
    return nm ? { lat, lon, nm } : null;
  }

  private cell(lat: number, lon: number) {
    // Radius that covers the whole cell (half-diagonal) + margin, capped at the API max (250 nm).
    const halfLatNm = (CELL_DEG / 2) * 60;
    const halfLonNm = (CELL_DEG / 2) * 60 * Math.cos((Math.min(Math.abs(lat) + CELL_DEG / 2, 89) * Math.PI) / 180);
    const radius = Math.min(250, Math.ceil(Math.hypot(halfLatNm, halfLonNm) + 10));
    return this.withFill(`cell:${lat}:${lon}`, Number(lat.toFixed(2)), Number(lon.toFixed(2)), radius);
  }

  /**
   * Point query through the provider chain, plus "gap filling": where the community feeds
   * return only a handful of aircraft (thin coverage, e.g. Sri Lanka), also ask OpenSky —
   * a separate receiver network — and merge. Needs OpenSky credentials (or OPENSKY_FILL=true),
   * is cached for 60 s per area and capped per day to protect the quota.
   */
  private async withFill(key: string, lat: number, lon: number, nm: number) {
    const r = await this.http.cached(key, CACHE_MS, async () => {
      const res = await this.pointChain.runWithSource(lat, lon, nm);
      this.sightings.noteScan({ kind: 'circle', lat, lon, nm });
      return res;
    });
    if (r.source === 'opensky' || r.value.length >= SPARSE || !this.fillEnabled()) return r;
    const extra = await this.http
      .cached(`fill:${key}`, 60_000, () => this.fillChain.run(lat, lon, nm), 5 * 60_000)
      .catch(() => [] as LiveAircraft[]);
    if (!extra.length) return r;
    const byHex = new Map(r.value.map((a) => [a.hex, a]));
    for (const a of extra) if (!byHex.has(a.hex)) byHex.set(a.hex, a);
    return { value: [...byHex.values()], source: `${r.source} + opensky` };
  }

  /**
   * Refresh (at most every 2 min) the regions around a viewport, so the server learns about
   * flights heading into it — used by the estimated-aircraft layer for thin-coverage areas.
   */
  async learnAround(b: Bounds) {
    const pad = 6; // degrees (~360 nm)
    if (BULK_URL) {
      // A fresh world snapshot already covers everything.
      if (this.http.peek('bulk:all') !== undefined) return;
      const box = {
        south: Math.max(-90, Math.floor(b.south - pad)),
        north: Math.min(90, Math.ceil(b.north + pad)),
        west: Math.floor(b.west - pad),
        east: Math.ceil(b.east + pad),
      };
      try {
        for (const part of splitBox(box)) {
          await this.http.cached(`ring:${part.south}:${part.north}:${part.west}:${part.east}`, 120_000, async () => {
            const r = await this.bulkChain.run({ kind: 'box', ...part });
            this.sightings.noteScan({ kind: 'box', ...part });
            return r;
          });
        }
        return;
      } catch {
        /* fall back to regional ring below */
      }
    }
    const ring = this.cellsFor({ north: b.north + pad, south: b.south - pad, east: b.east + pad, west: b.west - pad })
      .filter((c) => !(c.lat > b.south && c.lat < b.north && c.lon > b.west && c.lon < b.east));
    const cLat = (b.north + b.south) / 2;
    const cLon = (b.east + b.west) / 2;
    const chosen = ring.sort((x, y) => Math.hypot(x.lat - cLat, x.lon - cLon) - Math.hypot(y.lat - cLat, y.lon - cLon)).slice(0, 10);
    const radius = Math.min(250, Math.ceil(Math.hypot((CELL_DEG / 2) * 60, (CELL_DEG / 2) * 60) + 10));
    await this.mapLimit(chosen, 2, (c) =>
      this.http
        .cached(`ring:${c.lat}:${c.lon}`, 120_000, async () => {
          const r = await this.pointChain.runWithSource(c.lat, c.lon, radius);
          this.sightings.noteScan({ kind: 'circle', lat: c.lat, lon: c.lon, nm: radius });
          return r;
        })
        .catch(() => null),
    );
  }

  private fillEnabled() {
    const mode = process.env.OPENSKY_FILL ?? 'auto';
    if (mode === 'false') return false;
    return mode === 'true' || this.http.openSkyAuth.configured;
  }

  private cellsFor(b: Bounds) {
    const cells: { lat: number; lon: number }[] = [];
    const south = Math.max(-90, b.south);
    const north = Math.min(90, b.north);
    let west = b.west;
    let east = b.east;
    if (east - west >= 360) {
      west = -180;
      east = 180;
    }
    const i0 = Math.floor(south / CELL_DEG);
    const i1 = Math.floor(north / CELL_DEG);
    const j0 = Math.floor(west / CELL_DEG);
    const j1 = Math.floor(east / CELL_DEG);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        let lon = j * CELL_DEG + CELL_DEG / 2;
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        cells.push({ lat: i * CELL_DEG + CELL_DEG / 2, lon });
        if (cells.length > 400) return cells;
      }
    }
    return cells;
  }

  private inside(a: LiveAircraft, b: Bounds) {
    if (a.lat < b.south || a.lat > b.north) return false;
    if (b.east - b.west >= 360) return true;
    let lon = a.lon;
    // Support viewports that cross the antimeridian (Leaflet gives west < -180 or east > 180).
    while (lon < b.west) lon += 360;
    while (lon > b.east) lon -= 360;
    return lon >= b.west && lon <= b.east;
  }

  private async readsb(url: string, timeoutMs = 10_000): Promise<LiveAircraft[]> {
    const data = await this.http.getJson<{ ac?: any[]; aircraft?: any[] }>(url, timeoutMs);
    const list = data.ac ?? data.aircraft;
    if (!Array.isArray(list)) throw new Error('unexpected response shape');
    const out = list.map(normaliseAdsb).filter((a): a is LiveAircraft => a !== null);
    this.sightings.record(out, new URL(url).host.replace(/^(api|opendata)\./, ''));
    return out;
  }

  private openSkyPoint(lat: number, lon: number, nm: number) {
    const dLat = nm / 60;
    const dLon = nm / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const q = `lamin=${(lat - dLat).toFixed(2)}&lomin=${Math.max(-180, lon - dLon).toFixed(2)}&lamax=${(lat + dLat).toFixed(2)}&lomax=${Math.min(180, lon + dLon).toFixed(2)}`;
    return this.openSky(q);
  }

  private async openSky(query: string): Promise<LiveAircraft[]> {
    const data = await this.http.getJson<{ states?: any[][] | null }>(`${OPENSKY}/states/all${query ? `?${query}` : ''}`, 20_000);
    const out = (data.states ?? []).map(normaliseOpenSky).filter((a): a is LiveAircraft => a !== null);
    this.sightings.record(out, 'OpenSky');
    return out;
  }

  private async mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }
}

function clean(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length ? t : null;
}

export function normaliseAdsb(a: any): LiveAircraft | null {
  const lat = a.lat ?? a.lastPosition?.lat;
  const lon = a.lon ?? a.lastPosition?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const onGround = a.alt_baro === 'ground';
  const alt = onGround ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : null;
  const type: string = a.type ?? '';
  return {
    hex: String(a.hex).toLowerCase(),
    callsign: clean(a.flight),
    reg: clean(a.r),
    type: clean(a.t),
    desc: clean(a.desc),
    lat,
    lon,
    alt,
    onGround,
    gs: typeof a.gs === 'number' ? Math.round(a.gs) : null,
    track: typeof a.track === 'number' ? a.track : typeof a.true_heading === 'number' ? a.true_heading : null,
    vrate: typeof a.baro_rate === 'number' ? a.baro_rate : typeof a.geom_rate === 'number' ? a.geom_rate : null,
    squawk: clean(a.squawk),
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    category: clean(a.category),
    military: typeof a.dbFlags === 'number' ? (a.dbFlags & 1) === 1 : false,
    seen: typeof a.seen_pos === 'number' ? a.seen_pos : typeof a.seen === 'number' ? a.seen : 0,
    source: type.startsWith('adsb') ? 'adsb' : type === 'mlat' ? 'mlat' : 'other',
  };
}

function normaliseOpenSky(s: any[]): LiveAircraft | null {
  const [hex, callsign, , , lastContact, lon, lat, baroAltM, onGround, velMs, track, vrMs, , geoAltM, squawk] = s;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const altM = typeof baroAltM === 'number' ? baroAltM : typeof geoAltM === 'number' ? geoAltM : null;
  return {
    hex: String(hex).toLowerCase(),
    callsign: clean(callsign),
    reg: null,
    type: null,
    desc: null,
    lat,
    lon,
    alt: onGround ? 0 : altM === null ? null : Math.round(altM * 3.28084),
    onGround: !!onGround,
    gs: typeof velMs === 'number' ? Math.round(velMs * 1.94384) : null,
    track: typeof track === 'number' ? track : null,
    vrate: typeof vrMs === 'number' ? Math.round(vrMs * 196.85) : null,
    squawk: clean(squawk),
    emergency: squawk === '7700' ? 'general' : squawk === '7600' ? 'nordo' : squawk === '7500' ? 'unlawful' : null,
    category: null,
    military: false,
    seen: typeof lastContact === 'number' ? Math.max(0, Date.now() / 1000 - lastContact) : 0,
    source: 'opensky',
  };
}
