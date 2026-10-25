import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpCacheService } from '../common/http-cache.service';
import { ProviderChain } from '../common/provider-chain';
import { distanceNm } from '../common/geo';
import type { LiveAircraft } from '../flights/aircraft.types';

export interface Sighting {
  hex: string;
  callsign: string;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  type: string | null;
  reg: string | null;
  onGround: boolean;
  at: number;
  source: string;
}

/** A flight OpenSky saw take off and later lose (left coverage or landed). */
export interface DepartureRecord {
  hex: string;
  callsign: string;
  from: string | null;
  to: string | null;
  firstSeen: number;
  lastSeen: number;
}

const KEEP_MS = 18 * 3600_000;

/** An area we fetched live data for, and when — used to tell "silent" from "not looked at". */
export type ScanArea =
  | { kind: 'world' }
  | { kind: 'box'; south: number; north: number; west: number; east: number }
  | { kind: 'circle'; lat: number; lon: number; nm: number };
const MAX_SIGHTINGS = 80_000;
const WINDOW_S = 7_000; // OpenSky /flights/all accepts at most a 2 h window

/**
 * Free, keyless memory of where flights were last seen. Feeds the "estimated position"
 * fallback for flights that are currently out of receiver coverage.
 *  - every aircraft our API sees (any map view, search, snapshot) is remembered by callsign;
 *  - OpenSky's recent-flights list adds take-off/last-contact times for flights that left coverage.
 */
@Injectable()
export class SightingsService implements OnModuleInit {
  private readonly logger = new Logger(SightingsService.name);
  private readonly byCallsign = new Map<string, Sighting>();
  private readonly departures = new Map<string, DepartureRecord>();
  private coveredUntil = 0; // unix seconds up to which the departures index is complete
  private scans: { area: ScanArea; at: number }[] = [];
  private lastWorldScan = 0;
  readonly chain: ProviderChain<[number, number], DepartureRecord[]>;

  constructor(private readonly http: HttpCacheService) {
    this.chain = new ProviderChain(
      'opensky-flights',
      [{ name: 'opensky', run: (b: number, e: number) => this.fetchWindow(b, e) }],
      { threshold: 2, cooldownMs: 10 * 60_000, maxCooldownMs: 60 * 60_000 },
    );
  }

  onModuleInit() {
    if (process.env.OPENSKY_FLIGHTS_INDEX === 'false') return;
    setTimeout(() => void this.refresh(), 20_000).unref();
    setInterval(() => void this.refresh(), 20 * 60_000).unref();
  }

  stats() {
    return { sightings: this.byCallsign.size, departures: this.departures.size };
  }

  /** Remember the latest position of every aircraft that passes through the API. */
  record(list: LiveAircraft[], source: string) {
    const now = Date.now();
    for (const a of list) {
      if (!a.callsign) continue;
      const at = now - (a.seen ?? 0) * 1000;
      const prev = this.byCallsign.get(a.callsign);
      if (prev && prev.at >= at) continue;
      this.byCallsign.set(a.callsign, {
        hex: a.hex,
        callsign: a.callsign,
        lat: a.lat,
        lon: a.lon,
        // Keep good values if this (stale) report lacks them.
        alt: a.alt ?? prev?.alt ?? null,
        gs: a.gs ?? prev?.gs ?? null,
        track: a.track ?? prev?.track ?? null,
        vrate: a.vrate ?? prev?.vrate ?? null,
        type: a.type ?? prev?.type ?? null,
        reg: a.reg ?? prev?.reg ?? null,
        onGround: a.onGround,
        at,
        source,
      });
    }
    if (this.byCallsign.size > MAX_SIGHTINGS) this.prune(true);
  }

  /** Remember that we just fetched live data for an area (successfully). */
  noteScan(area: ScanArea, at = Date.now()) {
    if (area.kind === 'world') {
      this.lastWorldScan = at;
      return;
    }
    this.scans.push({ area, at });
    if (this.scans.length > 3000) this.scans = this.scans.filter((x) => at - x.at < 2 * 3600_000).slice(-2000);
  }

  /**
   * Was the point covered by a scan made after `after`? If so, and the aircraft wasn't in it,
   * the aircraft really went silent (left coverage). Otherwise we simply haven't looked.
   */
  checkedSince(lat: number, lon: number, after: number): boolean {
    if (this.lastWorldScan > after) return true;
    for (let i = this.scans.length - 1; i >= 0; i--) {
      const { area, at } = this.scans[i];
      if (at <= after) continue;
      if (area.kind === 'box') {
        let x = lon;
        while (x < area.west) x += 360;
        while (x > area.east) x -= 360;
        if (lat >= area.south && lat <= area.north && x >= area.west && x <= area.east) return true;
      } else if (area.kind === 'circle' && distanceNm(lat, lon, area.lat, area.lon) <= area.nm - 10) {
        return true;
      }
    }
    return false;
  }

  /** Recent sightings (newest data per callsign). */
  recent(maxAgeMs: number): Sighting[] {
    const cutoff = Date.now() - maxAgeMs;
    const out: Sighting[] = [];
    for (const s of this.byCallsign.values()) if (s.at >= cutoff) out.push(s);
    return out;
  }

  /** Departures OpenSky saw that went silent within the given window. */
  recentDepartures(maxAgeMs: number): DepartureRecord[] {
    const cutoff = (Date.now() - maxAgeMs) / 1000;
    const out: DepartureRecord[] = [];
    for (const d of this.departures.values()) if (d.lastSeen >= cutoff) out.push(d);
    return out;
  }

  sighting(callsign: string): Sighting | null {
    const s = this.byCallsign.get(callsign);
    return s && Date.now() - s.at < KEEP_MS ? s : null;
  }

  departure(callsign: string): DepartureRecord | null {
    const d = this.departures.get(callsign);
    return d && Date.now() - d.lastSeen * 1000 < KEEP_MS ? d : null;
  }

  // ---------------------------------------------------------------- OpenSky recent flights index

  private async refresh() {
    const now = Math.floor(Date.now() / 1000);
    let begin = Math.max(this.coveredUntil, now - 14 * 3600);
    try {
      while (begin < now - 60) {
        const end = Math.min(begin + WINDOW_S, now);
        const list = await this.chain.run(begin, end);
        for (const d of list) {
          const prev = this.departures.get(d.callsign);
          if (!prev || prev.lastSeen < d.lastSeen) this.departures.set(d.callsign, d);
        }
        this.coveredUntil = end;
        begin = end;
        // Be gentle with OpenSky's anonymous rate limit between windows.
        if (begin < now - 60) await new Promise((r) => setTimeout(r, 15_000));
      }
      this.prune(false);
      this.logger.log(`Departures index: ${this.departures.size} recent flights`);
    } catch (err) {
      this.logger.warn(`Departures index refresh failed (will retry): ${(err as Error).message}`);
    }
  }

  private async fetchWindow(begin: number, end: number): Promise<DepartureRecord[]> {
    const raw = await this.http.getJson<any[]>(`https://opensky-network.org/api/flights/all?begin=${begin}&end=${end}`, 30_000);
    if (!Array.isArray(raw)) throw new Error('unexpected response');
    return raw
      .filter((f) => typeof f.callsign === 'string' && f.callsign.trim() && f.icao24)
      .map((f) => ({
        hex: String(f.icao24).toLowerCase(),
        callsign: f.callsign.trim().toUpperCase(),
        from: f.estDepartureAirport ?? null,
        to: f.estArrivalAirport ?? null,
        firstSeen: f.firstSeen,
        lastSeen: f.lastSeen,
      }));
  }

  private prune(hard: boolean) {
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, v] of this.byCallsign) if (v.at < cutoff) this.byCallsign.delete(k);
    for (const [k, v] of this.departures) if (v.lastSeen * 1000 < cutoff) this.departures.delete(k);
    if (hard && this.byCallsign.size > MAX_SIGHTINGS) {
      const oldest = [...this.byCallsign.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of oldest.slice(0, this.byCallsign.size - MAX_SIGHTINGS * 0.8)) this.byCallsign.delete(k);
    }
  }
}

/** Typical block speed for jets incl. climb/descent, used when we have no measured speed. */
export const TYPICAL_KT = 440;

export function flightMinutes(nm: number) {
  return (nm / TYPICAL_KT) * 60 + 20;
}

export { distanceNm };
