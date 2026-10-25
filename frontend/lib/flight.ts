import type { Aircraft, Airport, Filters, FlightStatus, RouteInfo, Units } from './types';

// ---------------------------------------------------------------- geo

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Move a point along a track by `nm` nautical miles (dead reckoning). */
export function project(lat: number, lon: number, trackDeg: number, nm: number): [number, number] {
  const d = nm / R_NM;
  const t = rad(trackDeg);
  const la1 = rad(lat);
  const lo1 = rad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t));
  const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [deg(la2), ((deg(lo2) + 540) % 360) - 180];
}

/** Points along the great circle between two coordinates (for route lines). */
export function greatCircle(a: [number, number], b: [number, number], steps = 64): [number, number][] {
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (d === 0) return [a, b];
  const pts: [number, number][] = [];
  let prevLon = a[1];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    let lon = deg(Math.atan2(y, x));
    // Keep the line continuous across the antimeridian.
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    pts.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon]);
  }
  return pts;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (d: number) => COMPASS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
const COMPASS_WORDS: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };
export const compassWords = (d: number) => {
  const c = COMPASS[Math.round((((d % 360) + 360) % 360) / 45) * 2 % 16];
  return c.split('').map((ch) => COMPASS_WORDS[ch]).join('-');
};

// ---------------------------------------------------------------- formatting

export function fmtAlt(ft: number | null, units: Units, onGround = false) {
  if (onGround) return 'On ground';
  if (ft === null) return '—';
  if (units === 'metric') return `${Math.round(ft * 0.3048).toLocaleString()} m`;
  if (units === 'aviation' && ft >= 18000) return `FL${Math.round(ft / 100)}`;
  return `${Math.round(ft).toLocaleString()} ft`;
}

export function fmtSpeed(kt: number | null, units: Units) {
  if (kt === null) return '—';
  if (units === 'metric') return `${Math.round(kt * 1.852).toLocaleString()} km/h`;
  if (units === 'imperial') return `${Math.round(kt * 1.15078).toLocaleString()} mph`;
  return `${Math.round(kt)} kt`;
}

export function fmtDist(nm: number, units: Units) {
  if (units === 'metric') return `${Math.round(nm * 1.852).toLocaleString()} km`;
  if (units === 'imperial') return `${Math.round(nm * 1.15078).toLocaleString()} mi`;
  return `${Math.round(nm).toLocaleString()} nm`;
}

export function fmtVrate(fpm: number | null, units: Units) {
  if (fpm === null) return '—';
  if (units === 'metric') return `${(fpm * 0.00508).toFixed(1)} m/s`;
  return `${fpm > 0 ? '+' : ''}${Math.round(fpm).toLocaleString()} ft/min`;
}

export function fmtTemp(c: number | null, units: Units) {
  if (c === null) return '—';
  return units === 'imperial' ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`;
}

export function fmtDuration(mins: number) {
  if (!Number.isFinite(mins)) return '—';
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function fmtClock(date: Date, timeZone?: string | null, offsetSeconds?: number) {
  try {
    if (timeZone) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone });
  } catch {
    /* unknown tz → fall through */
  }
  if (offsetSeconds !== undefined) {
    const d = new Date(date.getTime() + offsetSeconds * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const airportLabel = (a: Airport | null | undefined) => (a ? a.city?.split(',')[0] || a.name : 'Unknown');
export const airportCode = (a: Airport | null | undefined) => (a ? a.iata ?? a.icao : '???');

// ---------------------------------------------------------------- classification

/** Altitude → colour ramp used for map icons and legend. */
export function altColor(a: Pick<Aircraft, 'alt' | 'onGround' | 'emergency' | 'squawk'>) {
  if (a.emergency || a.squawk === '7700' || a.squawk === '7600' || a.squawk === '7500') return '#ef4444';
  if (a.onGround) return '#94a3b8';
  const ft = a.alt ?? 0;
  const stops: [number, [number, number, number]][] = [
    [0, [250, 204, 21]],
    [4000, [251, 146, 60]],
    [10000, [74, 222, 128]],
    [20000, [56, 189, 248]],
    [30000, [129, 140, 248]],
    [40000, [217, 70, 239]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (ft <= stops[i][0]) {
      const [a0, c0] = stops[i - 1];
      const [a1, c1] = stops[i];
      const f = (ft - a0) / (a1 - a0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(217,70,239)';
}

export type Kind = 'airliner' | 'light' | 'heli' | 'military' | 'other';

export function kindOf(a: Aircraft): Kind {
  if (a.military) return 'military';
  const c = a.category ?? '';
  if (c === 'A7') return 'heli';
  if (c === 'A3' || c === 'A4' || c === 'A5' || c === 'A6') return 'airliner';
  if (c === 'A1' || c === 'A2') return 'light';
  if (!c && a.callsign && /^[A-Z]{3}\d/.test(a.callsign)) return 'airliner';
  if (!c && (a.alt ?? 0) > 25000) return 'airliner';
  return c.startsWith('B') || c.startsWith('C') ? 'other' : c ? 'other' : 'light';
}

export function isEmergency(a: Aircraft) {
  return !!a.emergency || ['7700', '7600', '7500'].includes(a.squawk ?? '');
}

export function passesFilters(a: Aircraft, f: Filters) {
  if (isEmergency(a)) return true; // never hide emergencies
  if (f.hideGround && a.onGround) return false;
  const alt = a.onGround ? 0 : a.alt ?? 0;
  if (alt < f.minAlt || (f.maxAlt < 50000 && alt > f.maxAlt)) return false;
  if (!f.kinds[kindOf(a)]) return false;
  if (f.query) {
    const q = f.query.toUpperCase();
    const hay = `${a.callsign ?? ''} ${a.reg ?? ''} ${a.type ?? ''} ${a.hex}`.toUpperCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- plain-language status

export type Phase = 'parked' | 'taxi' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach' | 'level' | 'unknown';

export function phaseOf(a: Aircraft): Phase {
  const gs = a.gs ?? 0;
  const vr = a.vrate ?? 0;
  const alt = a.alt ?? 0;
  if (a.onGround) return gs < 3 ? 'parked' : gs < 45 ? 'taxi' : 'takeoff';
  if (a.alt === null) return 'unknown';
  if (vr > 400) return alt < 3000 ? 'takeoff' : 'climb';
  if (vr < -400) return alt < 10000 ? 'approach' : 'descent';
  if (alt > 20000) return 'cruise';
  return 'level';
}

export const PHASE_LABEL: Record<Phase, string> = {
  parked: 'At the gate',
  taxi: 'Taxiing',
  takeoff: 'Taking off',
  climb: 'Climbing',
  cruise: 'Cruising',
  descent: 'Descending',
  approach: 'On approach',
  level: 'In flight',
  unknown: 'In flight',
};

export const PHASE_EMOJI: Record<Phase, string> = {
  parked: '🅿️', taxi: '🛞', takeoff: '🛫', climb: '↗️', cruise: '✈️', descent: '↘️', approach: '🛬', level: '✈️', unknown: '✈️',
};

export interface Progress {
  flownNm: number;
  remainingNm: number;
  totalNm: number;
  pct: number;
  /** Estimated minutes to touchdown (null if not airborne/moving). */
  etaMinutes: number | null;
}

export function progressOf(a: Aircraft, r: RouteInfo | null): Progress | null {
  if (!r?.origin || !r.destination) return null;
  const flown = distanceNm(r.origin.lat, r.origin.lon, a.lat, a.lon);
  const remaining = distanceNm(a.lat, a.lon, r.destination.lat, r.destination.lon);
  const total = flown + remaining;
  let eta: number | null = null;
  if (!a.onGround && a.gs && a.gs > 80) {
    // Cruise speed overstates the last few miles; add a small approach/landing allowance.
    const effective = remaining > 150 ? a.gs * 0.97 : Math.max(140, a.gs * 0.8);
    eta = (remaining / effective) * 60 + (remaining > 40 ? 8 : 3);
  }
  return { flownNm: flown, remainingNm: remaining, totalNm: total, pct: total ? Math.min(1, flown / total) : 0, etaMinutes: eta };
}

export function plainStatus(a: Aircraft, r: RouteInfo | null, units: Units): string {
  const p = phaseOf(a);
  const dest = r?.destination ? airportLabel(r.destination) : null;
  const prog = progressOf(a, r);
  const alt = fmtAlt(a.alt, units);
  const spd = fmtSpeed(a.gs, units);
  switch (p) {
    case 'parked':
      return r?.origin && distanceNm(a.lat, a.lon, r.origin.lat, r.origin.lon) < 5
        ? `Parked at ${airportLabel(r.origin)}, waiting to depart.`
        : dest && prog && prog.remainingNm < 5
          ? `Arrived at ${dest}. Parked at the gate.`
          : 'Parked on the ground.';
    case 'taxi':
      return dest && prog && prog.remainingNm < 5 ? `Landed in ${dest} and taxiing to the gate.` : 'Taxiing on the ground.';
    case 'takeoff':
      return a.onGround ? 'Rolling down the runway.' : `Just took off — climbing through ${alt}.`;
    case 'climb':
      return `Climbing through ${alt} at ${spd}${dest ? ` on the way to ${dest}` : ''}.`;
    case 'cruise':
      return `Cruising at ${alt}, ${spd}${dest && prog?.etaMinutes ? ` — about ${fmtDuration(prog.etaMinutes)} to ${dest}` : ''}.`;
    case 'descent':
      return `Started descending${dest ? ` towards ${dest}` : ''} — now at ${alt}.${prog?.etaMinutes ? ` Landing in about ${fmtDuration(prog.etaMinutes)}.` : ''}`;
    case 'approach':
      return `On final approach${dest ? ` into ${dest}` : ''}, ${alt}.${prog?.etaMinutes ? ` Touchdown in ~${fmtDuration(prog.etaMinutes)}.` : ''}`;
    default:
      return `Flying at ${alt}, ${spd}.`;
  }
}

/** Sky position as seen from an observer on the ground. */
export function skyPosition(obs: { lat: number; lon: number }, a: Aircraft) {
  const dNm = distanceNm(obs.lat, obs.lon, a.lat, a.lon);
  const brg = bearing(obs.lat, obs.lon, a.lat, a.lon);
  const altM = (a.alt ?? 0) * 0.3048;
  const elev = deg(Math.atan2(altM, Math.max(1, dNm * 1852)));
  return { distanceNm: dNm, bearing: brg, elevation: elev };
}

// ---------------------------------------------------------------- estimated position (no live signal)

/** Point a fraction `f` of the way along the great circle from a to b. */
export function pointAlong(a: [number, number], b: [number, number], f: number): [number, number] {
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (d === 0) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return [deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))];
}

export interface EstimatedPosition {
  lat: number;
  lon: number;
  track: number;
  fraction: number;
  minutesToGo: number;
}

/**
 * Where an airborne flight should be right now, from its takeoff time and estimated landing
 * time, assuming it follows the great circle. Mirrors what big trackers show over oceans.
 */
export function estimatePosition(s: FlightStatus | null | undefined, origin: Airport | null, dest: Airport | null, now = Date.now()): EstimatedPosition | null {
  if (!s || !origin || !dest || s.phase !== 'airborne') return null;
  const dep = Date.parse(s.times.actualOff ?? s.times.actualOut ?? s.times.estimatedOff ?? '');
  const arr = Date.parse(s.times.estimatedOn ?? s.times.scheduledOn ?? s.times.estimatedIn ?? s.times.scheduledIn ?? '');
  if (!Number.isFinite(dep) || !Number.isFinite(arr) || arr <= dep) return null;
  const fraction = Math.min(0.995, Math.max(0.005, (now - dep) / (arr - dep)));
  const [lat, lon] = pointAlong([origin.lat, origin.lon], [dest.lat, dest.lon], fraction);
  return { lat, lon, track: bearing(lat, lon, dest.lat, dest.lon), fraction, minutesToGo: Math.max(0, (arr - now) / 60_000) };
}

/** Clock time in an airport's own timezone, e.g. "19:40". */
export function fmtLocal(iso: string | null | undefined, timeZone?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fmtClock(d, timeZone);
}
