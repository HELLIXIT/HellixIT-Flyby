/** Normalised live aircraft state returned by every flights endpoint. */
export interface LiveAircraft {
  hex: string;
  callsign: string | null;
  reg: string | null;
  type: string | null;
  desc: string | null;
  lat: number;
  lon: number;
  /** Barometric altitude in feet (0 when on ground). */
  alt: number | null;
  onGround: boolean;
  /** Ground speed, knots. */
  gs: number | null;
  /** Track over ground, degrees. */
  track: number | null;
  /** Vertical rate, ft/min. */
  vrate: number | null;
  squawk: string | null;
  emergency: string | null;
  category: string | null;
  military: boolean;
  /** Seconds since last position update. */
  seen: number;
  source: 'adsb' | 'mlat' | 'other' | 'opensky';
}

export interface AreaResponse {
  now: number;
  source: string;
  total: number;
  aircraft: LiveAircraft[];
}
