export interface Aircraft {
  hex: string;
  callsign: string | null;
  reg: string | null;
  type: string | null;
  desc: string | null;
  lat: number;
  lon: number;
  alt: number | null;
  onGround: boolean;
  gs: number | null;
  track: number | null;
  vrate: number | null;
  squawk: string | null;
  emergency: string | null;
  category: string | null;
  military: boolean;
  seen: number;
  source: string;
  alertReason?: string;
  distanceNm?: number;
  etaMinutes?: number | null;
}

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

export interface RouteInfo {
  callsign: string;
  callsignIata: string | null;
  airline: { name: string; icao: string | null; iata: string | null } | null;
  origin: Airport | null;
  destination: Airport | null;
  source: string;
}

export interface AircraftInfo {
  registration: string | null;
  type: string | null;
  icaoType: string | null;
  manufacturer: string | null;
  owner: string | null;
  ownerCountry: string | null;
}

export interface Photo {
  thumbnail: string;
  large: string | null;
  link: string | null;
  photographer: string | null;
  source: string;
}

export interface FlightDetails {
  live: Aircraft | null;
  route: RouteInfo | null;
  routeConfidence: 'high' | 'low' | null;
  aircraft: AircraftInfo | null;
  photo: Photo | null;
}

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
  summary: string;
  source: string;
}

export interface AirportDetails {
  airport: Airport;
  weather: Weather | null;
  metar: Metar | null;
}

export interface AirportTraffic {
  airport: Airport;
  source: string;
  degraded: boolean;
  arrivals: Aircraft[];
  departures: Aircraft[];
  onGround: Aircraft[];
}

export interface AreaResponse {
  now: number;
  source: string;
  degraded: boolean;
  total: number;
  truncated: boolean;
  aircraft: Aircraft[];
}

export interface WatchItem {
  /** Aircraft hex, or `cs:<CALLSIGN>` while a flight is waiting to appear in coverage. */
  hex: string;
  callsign: string | null;
  label: string;
  addedAt: number;
  /** Minutes it takes the user to reach the destination airport (pickup assistant). */
  travelMinutes?: number;
  /** "SHJ → CMB" — shown while the flight isn't visible yet. */
  routeLabel?: string;
}

export interface StatusAirport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  city: string | null;
  timezone: string | null;
}

/** Schedule-based status from FlightAware AeroAPI (only when a key is configured). */
export interface FlightStatus {
  /** 'flightaware' = schedule data; 'estimate' = Flyby's own estimate from the last radar contact. */
  source: 'flightaware' | 'estimate';
  basis?: string;
  hex?: string | null;
  ident: string;
  identIata: string | null;
  status: string;
  phase: 'scheduled' | 'taxiing' | 'airborne' | 'landed' | 'arrived' | 'cancelled' | 'diverted';
  cancelled: boolean;
  diverted: boolean;
  progressPercent: number | null;
  origin: StatusAirport | null;
  destination: StatusAirport | null;
  aircraftType: string | null;
  registration: string | null;
  departureDelayMin: number | null;
  arrivalDelayMin: number | null;
  gateOrigin: string | null;
  gateDestination: string | null;
  terminalOrigin: string | null;
  terminalDestination: string | null;
  baggageClaim: string | null;
  times: Record<
    | 'scheduledOut' | 'estimatedOut' | 'actualOut'
    | 'scheduledOff' | 'estimatedOff' | 'actualOff'
    | 'scheduledOn' | 'estimatedOn' | 'actualOn'
    | 'scheduledIn' | 'estimatedIn' | 'actualIn',
    string | null
  >;
  fetchedAt: string;
  faFlightId?: string | null;
  /** On final approach (inferred from the live position). */
  landing?: boolean;
  /** FlightAware's latest real position (A=ADS-B, M=MLAT, Z=radar, S=satellite, P=projected…). */
  lastPosition?: { lat: number; lon: number; alt: number | null; gs: number | null; heading: number | null; at: string; updateType: string | null } | null;
}

export interface KnownFlight {
  callsign: string;
  flightNumber: string;
  route: RouteInfo;
  status?: FlightStatus | null;
}

export type Units = 'metric' | 'imperial' | 'aviation';
export type MapStyle = 'dark' | 'light' | 'satellite' | 'terrain';

/** A flight that recently left receiver coverage, moved forward along its route (estimate). */
export interface EstimatedAircraft {
  hex: string;
  callsign: string;
  reg: string | null;
  type: string | null;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number;
  silentSec: number;
  method: 'route' | 'heading' | 'departure' | 'schedule' | 'flightaware';
  lastSeenSource: string;
  origin: Airport | null;
  destination: Airport | null;
  flightNumber: string | null;
  airline: string | null;
  etaMinutes: number | null;
}

export interface Settings {
  /** Spoken radar announcements in "Above me" (off by default). */
  voice: boolean;
  /** 'device' = best/selected system voice; 'kokoro' = neural voice running in the browser. */
  voiceEngine: 'device' | 'kokoro';
  /** Selected device voice name (null = best available). */
  deviceVoice: string | null;
  kokoroVoice: string;
  /** Show estimated positions for flights that recently left receiver coverage. */
  showEstimated: boolean;
  units: Units;
  mapStyle: MapStyle;
  theme: 'dark' | 'light';
  showTrails: boolean;
  showAirports: boolean;
  notifications: boolean;
}

export interface Filters {
  minAlt: number;
  maxAlt: number;
  hideGround: boolean;
  query: string;
  kinds: { airliner: boolean; light: boolean; heli: boolean; military: boolean; other: boolean };
}

/** Compact airport marker data (from /airports/map). */
export interface MapAirport {
  iata: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
  large: boolean;
}

export interface GroundFlight {
  ident: string;
  identIata: string | null;
  operator: string | null;
  otherAirport: { code: string | null; city: string | null; name: string | null } | null;
  time: string | null;
  scheduledTime: string | null;
  delayMin: number | null;
  gate: string | null;
  terminal: string | null;
  baggage: string | null;
  aircraftType: string | null;
  registration: string | null;
  status: string;
}
