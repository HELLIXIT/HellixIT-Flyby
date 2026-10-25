import type {
  Aircraft,
  Airport,
  AirportDetails,
  AirportTraffic,
  AreaResponse,
  EstimatedAircraft,
  FlightDetails,
  FlightStatus,
  GroundFlight,
  KnownFlight,
  MapAirport,
  Weather,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** GET with timeout + one automatic retry on network/5xx errors. */
async function get<T>(path: string, { timeoutMs = 20_000, retries = 1, signal }: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(`/api/${path}`, { signal: ctrl.signal, cache: 'no-store' });
      if (res.ok) return (await res.json()) as T;
      const err = new ApiError(`HTTP ${res.status}`, res.status);
      if (res.status < 500) throw err;
      lastErr = err;
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) throw err;
      if (signal?.aborted) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr;
}

export const api = {
  bounds: (b: { n: number; s: number; e: number; w: number }, signal?: AbortSignal) =>
    get<AreaResponse>(`flights/bounds?n=${b.n.toFixed(3)}&s=${b.s.toFixed(3)}&e=${b.e.toFixed(3)}&w=${b.w.toFixed(3)}`, {
      signal,
      timeoutMs: 70_000,
      retries: 0,
    }),
  estimated: (b: { n: number; s: number; e: number; w: number }) =>
    get<{ aircraft: EstimatedAircraft[] }>(`flights/estimated?n=${b.n.toFixed(3)}&s=${b.s.toFixed(3)}&e=${b.e.toFixed(3)}&w=${b.w.toFixed(3)}`, { retries: 0 }),
  flight: (hex: string) => get<{ aircraft: Aircraft | null }>(`flights/${hex}`),
  byCallsign: (cs: string) => get<{ aircraft: Aircraft | null }>(`flights/callsign/${encodeURIComponent(cs)}`),
  details: (hex: string, callsign?: string | null) =>
    get<FlightDetails>(`flights/${hex}/details${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ''}`),
  search: (q: string, signal?: AbortSignal) =>
    get<{ flights: Aircraft[]; airports: Airport[]; resolvedCallsign: string | null; knownFlight: KnownFlight | null }>(`flights/search?q=${encodeURIComponent(q)}`, {
      signal,
      retries: 0,
    }),
  alerts: () => get<{ aircraft: Aircraft[] }>('flights/alerts'),
  military: () => get<{ aircraft: Aircraft[] }>('flights/military'),
  airport: (code: string) => get<AirportDetails>(`airports/${encodeURIComponent(code)}`),
  airportTraffic: (code: string) => get<AirportTraffic>(`airports/${encodeURIComponent(code)}/traffic`, { timeoutMs: 40_000 }),
  majorAirports: () => get<{ airports: Airport[] }>('airports/major'),
  mapAirports: async (): Promise<MapAirport[]> => {
    const r = await get<{ airports: [string, string, string, number, number, 'L' | 'M'][] }>('airports/map', { timeoutMs: 70_000 });
    return r.airports.map(([iata, icao, name, lat, lon, size]) => ({ iata, icao, name, lat, lon, large: size === 'L' }));
  },
  airportGround: (code: string) =>
    get<{ scheduleEnabled: boolean; landed: GroundFlight[]; departing: GroundFlight[]; error?: string }>(`airports/${encodeURIComponent(code)}/ground`, {
      timeoutMs: 40_000,
    }),
  nearbyAirports: (lat: number, lon: number) => get<{ airports: (Airport & { distanceNm: number })[] }>(`airports/nearby?lat=${lat}&lon=${lon}`),
  config: () => get<{ cartoApiKey: string | null; airplanesLiveEnabled: boolean; flightStatusEnabled: boolean }>('config', { timeoutMs: 70_000 }),
  status: (callsign: string) => get<{ enabled: boolean; status: FlightStatus | null }>(`status/${encodeURIComponent(callsign)}`),
  weather: (lat: number, lon: number) => get<Weather>(`weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`),
};
