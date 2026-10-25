# ✈️ Flyby — a friendlier live flight tracker

Flyby is a FlightAware-style tracker built around plain language instead of raw data. It runs entirely on **free, keyless data sources**, and when one source fails it switches to the next on its own.

```
backend/         NestJS API: aggregation, caching, provider failover
frontend/        Next.js 16 (App Router) + Leaflet web app
scripts/run.mjs  Runs both as one app (dev & production)
.env.example     All settings for both, in one file
render.yaml      One-click Render Blueprint (a single web service)
```

The API and web app ship as **one app**. `scripts/run.mjs` starts the NestJS API on an internal port (`API_PORT`, localhost only) and Next.js on the public `PORT`. The browser only talks to Next.js, whose `/api/*` route proxies to the API. If either process crashes, the whole app exits so the host restarts it cleanly.

## Features

| | |
|---|---|
| **Live map** | Aircraft icons coloured by altitude, with separate shapes for jets, light aircraft, helicopters and military. Planes move smoothly between updates (dead reckoning). Callsign labels appear when you zoom in. |
| **Plain-language status** | Status reads like *"Started descending towards London — now at 18,000 ft. Landing in about 22 min."* instead of a page of numbers. |
| **Route progress and ETA** | Origin → destination progress bar, distance flown and remaining, and an estimated landing time in both the destination's local time and yours. |
| **🚗 Pickup assistant** | Enter how long it takes you to get to the airport. Flyby adds deplaning time (and customs on international flights) and tells you when to leave, then sends a notification when it's time. |
| **★ My Flights** | Star a flight to get in-app and browser alerts on takeoff, start of descent, landing and emergency squawks. |
| **📍 Above me** | Uses your location to list the aircraft around you, with where to look in the sky (*"NE 35°↑"*), an animated radar (estimated planes shown dashed) and a draggable range slider (9–278 km) plus presets. Optional **voice announcements** (off by default; 🔊 button or Settings) speak when aircraft enter the range, turn, are about to leave and leave, with on-screen captions. Voices (Settings → Voice): the **most natural voice on your device** is picked automatically (Edge "Natural", Google, Apple Premium/Siri-grade) with a picker and ▶ Test, or a **Natural AI voice** — the open-source Kokoro neural model running entirely in your browser (no key, no server; ~90 MB downloaded once, then offline). The site is served cross-origin-isolated (`COEP: credentialless`) so the AI voice can use all CPU cores. The radar keeps its own data feed around you, so panning the map never triggers false "left the radar" calls. |
| **Airport view** | Local time, current weather, METAR explained in plain English (VFR/IFR → "minor delays possible"), a live arrivals/departures board built from real positions, and an **At the airport** tab (aircraft heard on the ground + recently landed / departing-soon flights with gates, with a FlightAware key). Airports are marked on the map (major from zoom 3, medium from zoom 7). |
| **Universal search** | One box for flight numbers (`BA123` is converted to the broadcast callsign `BAW123`), callsigns, registrations, ICAO hex codes and airport names or codes. Remembers recent searches. |
| **🚨 Alerts** | Live worldwide feed of 7700/7600/7500 squawks, each explained in plain words, plus an optional military aircraft layer. |
| **Estimated aircraft layer** | Like the big trackers' "estimated" planes: flights that recently left receiver coverage (oceans, thin-coverage countries) stay on the map as dashed icons, moved along their route to the destination (or their last heading for ≤ 20 min if the route is unknown) and removed once they should have landed. A plane only counts as silent if its last area was checked again and it was missing (not merely because nobody looked). With a FlightAware key, departure boards of major airports that no receiver covers (e.g. Colombo) add every departing flight automatically. Other sources: the server's memory of every flight it has seen (it also scans the regions around a sparse viewport to learn about inbound flights) and OpenSky's recent-departures list. Toggle in Settings. |
| **Filters** | Altitude range, hide aircraft on the ground, aircraft categories and free-text search within the view. Emergencies always stay visible. |
| **Whole-world view** | Zoom all the way out and every aircraft the network can see (5,000+) appears in under a second; busy views are drawn on a single canvas (hover + click still work), responses are gzipped (~1.5 MB → ~260 KB). |
| **Extras** | Photo of the actual aircraft, altitude and speed sparklines, highest/fastest aircraft in view, shareable deep links (`?flight=<hex>`, `?airport=LHR`), dark/light/satellite/terrain maps, metric/imperial/aviation units, keyboard shortcuts (`/` `Esc` `M` `O` `F` `A`), and a mobile bottom-sheet layout. |

## Resilience: provider failover

Each kind of data comes from an ordered **provider chain** ([backend/src/common/provider-chain.ts](backend/src/common/provider-chain.ts)). Every provider has a circuit breaker:

- After repeated failures, or straight away on HTTP 429, the provider is skipped for a cooldown that backs off exponentially (30 s up to 5 min). Requests go to the next provider meanwhile.
- Per-provider rate limiting keeps requests inside each free tier, and a provider's `Retry-After` (e.g. OpenSky's daily-quota reset) is honoured exactly.
- Answers are cached with a TTL. If every provider fails, **stale data is served** for a grace period instead of an error.
- Requests for the same key that arrive together share a single upstream call.

| Data | Chain (in order) |
|---|---|
| Live positions (viewport) | **adsb.lol re-api**: one request per viewport — the whole-network snapshot (~5–6k aircraft, shared by all users, 15 s) for wide views, a single box query for smaller ones → falls back to the regional chain below |
| Live positions (regional fallback) | adsb.lol → adsb.fi → *(airplanes.live, opt-in)* → OpenSky. Plus **gap filling**: areas where the feeds return < 8 aircraft are topped up from OpenSky (with OpenSky credentials; cached 60 s, daily cap) |
| Hex lookup | adsb.lol → adsb.fi → *(airplanes.live)* → OpenSky |
| Callsign / registration search | All ADS-B networks **in parallel** (each has different receivers) → OpenSky worldwide snapshot (callsigns, cached 90 s). If a real flight (route known) is in none of them, search says it's out of coverage and offers "Notify me when it's visible". |
| Flight route | adsbdb → hexdb.io (+ offline airline table for IATA → ICAO) |
| Status & estimated position for out-of-coverage flights | FlightAware AeroAPI *(if key)* → **Flyby estimate (keyless)**: dead-reckoning from the last time any network saw the flight (our own sightings memory + OpenSky's recent-flights list) |
| ↳ FlightAware detail | FlightAware AeroAPI — only with `FLIGHTAWARE_AEROAPI_KEY`; cached 5 min, daily call cap. Used for flights no receiver can hear (search card + dashed "estimated" plane on the map) and on demand in the flight panel. |
| Aircraft info | adsbdb → hexdb.io |
| Photos | Planespotters → hexdb.io |
| Weather | Open-Meteo → MET Norway |
| METAR | aviationweather.gov → VATSIM METAR |
| Airport database | Bundled snapshot (instant boot) → refreshed from OurAirports → GitHub mirror |
| Map tiles | CARTO (if `CARTO_API_KEY` is set) → Esri basemaps → OpenStreetMap (switched in the browser) |

The web app keeps showing the last known positions when the API can't be reached, backs off its polling, and shows the connection state in the top-right (Live, backup source, waking up, reconnecting).

`GET /api/health` reports every provider's state. The same report appears in **Settings → Data sources**.

## Run locally

Requires Node 20+ (22 recommended).

```bash
npm install          # also installs backend/ and frontend/ dependencies
cp .env.example .env # optional — edit settings
npm run dev          # starts API + web together, both in watch mode
```

Open http://localhost:3000. Production mode: `npm run build && npm start`.

## Deploy to Render

1. Push this repo to GitHub or GitLab.
2. In Render, go to **New → Blueprint** and pick the repo. [render.yaml](render.yaml) creates one web service, `flyby`, that builds with `npm install && npm run build`, starts with `npm start`, and health-checks `/healthz` (which passes only when both the web app and the API respond).
3. Render asks for `CARTO_API_KEY`. Leave it blank to use Esri tiles.
4. To change other settings later, go to **flyby → Environment**. Render's variables override `.env`, and a restart applies them without a rebuild.

Free-plan services sleep when idle. The first request after a sleep takes a little while to answer.

## Configuration

Every setting lives in one file, [.env.example](.env.example). Copy it to `.env` for local use, or set the same keys in Render's Environment tab.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Public port of the app (Render sets this) |
| `API_PORT` | `4000` | Internal API port |
| `CARTO_API_KEY` | — | Optional [CARTO basemap key](https://carto.com/basemaps/apikey/). When set, the Dark and Light maps use CARTO (Esri and OSM stay as fallbacks). A wrong key shows watermarked tiles rather than an error. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | — | Optional free OpenSky account (OAuth2 API client). Much higher daily quota than anonymous access |
| `LIVE_BULK_URL` | `https://re-api.adsb.lol/` | Whole-network/box endpoint for viewport queries; set empty to use only regional queries |
| `ESTIMATE_MAX_MINUTES` | `90` | Stop showing an estimated plane after this long without a signal |
| `OPENSKY_FILL` / `OPENSKY_FILL_MAX_PER_DAY` | `auto` / `1500` | Top up thin-coverage areas from OpenSky (auto = when credentials are set) |
| `OPENSKY_FLIGHTS_INDEX` | `true` | Keyless estimates: index OpenSky's recent flights every 20 min |
| `FLIGHTAWARE_AEROAPI_KEY` | — | Optional. Adds schedules, delays, gates and estimated positions for out-of-coverage flights ([free Personal tier](https://www.flightaware.com/commercial/aeroapi/): $5/month of queries) |
| `AEROAPI_MAX_CALLS_PER_DAY` | `30` | Hard daily cap on AeroAPI calls, protecting the free credit |
| `AEROAPI_BOARD_CALLS_PER_DAY` / `AEROAPI_BOARD_REFRESH_MIN` | `24` / `60` | Departure boards for major airports without receiver coverage (e.g. Colombo) feed the estimated layer; separate daily cap, only fetched while the area is viewed |
| `AEROAPI_AREA_CALLS_PER_DAY` / `AEROAPI_AREA_REFRESH_MIN` | `24` / `10` | FlightAware area search for viewports the free networks barely cover (shows overflights etc.); separate daily cap |
| `AEROAPI_GROUND_CALLS_PER_DAY` / `AEROAPI_GROUND_REFRESH_MIN` | `24` / `15` | "At the airport" tab (recently landed / departing soon, with gates), fetched only when opened |
| `AEROAPI_VERIFY_CALLS_PER_DAY` | `120` | Background check of estimated planes against FlightAware: landed/cancelled/diverted ones are removed, airborne ones marked ✓ verified |
| `AIRPLANES_LIVE_ENABLED` | `false` | Adds airplanes.live to the live-data chain. **Only set `true` after airplanes.live approves you**; otherwise they return 403 and the chain skips them anyway. |
| `ADSB_PROVIDERS` | — | Explicit feed order, e.g. `adsbfi,adsblol,airplaneslive` |
| `LIVE_CACHE_MS` | `5000` | How long live position responses are reused |
| `ADSBLOL_MIN_INTERVAL_MS` | `400` | Gap between adsb.lol calls |
| `AIRPORTS_REFRESH` | `true` | Refresh the airport DB from OurAirports at boot and weekly |
| `UPSTREAM_USER_AGENT` | Flyby/1.0 … | Descriptive UA (Planespotters requires one) |
| `CORS_ORIGINS` | `*` | Allowed origins for direct browser calls to the API |
| `BACKEND_URL` / `BACKEND_FALLBACK_URLS` | — | Advanced: point the web app at an external API instead of the built-in one |

## API reference (NestJS, prefix `/api`)

| Endpoint | Description |
|---|---|
| `GET /flights/bounds?n&s&e&w` | Aircraft inside a map viewport |
| `GET /flights/search?q=` | Flights (callsign, flight number, registration, hex) and airports |
| `GET /flights/:hex` | Live state of one aircraft |
| `GET /flights/:hex/details` | Live state, route, aircraft info and photo in one call |
| `GET /flights/alerts` | Emergency squawks worldwide |
| `GET /flights/military` | Military aircraft |
| `GET /airports/search?q=` · `/airports/nearby?lat&lon` · `/airports/major` | Airport lookup |
| `GET /airports/:code` | Airport, current weather and METAR |
| `GET /airports/:code/traffic` | Live arrivals, departures and aircraft on the ground |
| `GET /weather?lat&lon` · `/weather/metar/:icao` | Weather |
| `GET /health` | Provider and circuit-breaker status |

## Data credits

Live positions come from the community ADS-B networks [adsb.lol](https://adsb.lol) (ODbL), [adsb.fi](https://adsb.fi) and [OpenSky Network](https://opensky-network.org). Routes and aircraft data come from [adsbdb](https://www.adsbdb.com) and [hexdb.io](https://hexdb.io). Photos are from [Planespotters.net](https://www.planespotters.net). Weather comes from [Open-Meteo](https://open-meteo.com), [MET Norway](https://api.met.no), [aviationweather.gov](https://aviationweather.gov) and [VATSIM](https://vatsim.net). Airports are from [OurAirports](https://ourairports.com) (public domain). Map tiles are from Esri and OpenStreetMap. Please respect each provider's terms and rate limits; for heavy production traffic, consider feeding data to or sponsoring these networks.

Route data is crowd-sourced. Flyby checks it against the aircraft's actual position and warns when the two don't match.
