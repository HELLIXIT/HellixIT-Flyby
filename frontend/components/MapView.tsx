'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Aircraft, EstimatedAircraft, MapAirport, MapStyle, Units } from '@/lib/types';
import { altColor, fmtAlt, fmtSpeed, greatCircle, isEmergency, kindOf, project } from '@/lib/flight';
import { PlaneCanvasLayer } from '@/lib/planeCanvas';

/** Above this many aircraft, draw them on a canvas instead of one DOM marker each. */
const CANVAS_THRESHOLD = 600;

export interface MapHandle {
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  fitPoints: (pts: [number, number][]) => void;
  getCenter: () => { lat: number; lon: number; zoom: number };
}

export interface ViewBounds {
  n: number;
  s: number;
  e: number;
  w: number;
  zoom: number;
}

interface Props {
  aircraft: Aircraft[];
  receivedAt: number;
  selectedHex: string | null;
  watched: Set<string>;
  trail: { lat: number; lon: number; alt: number | null }[];
  route: { origin: [number, number] | null; destination: [number, number] | null } | null;
  airports: MapAirport[];
  showAirports: boolean;
  mapStyle: MapStyle;
  /** Optional CARTO basemap key (from CARTO_API_KEY); without it Esri tiles are used. */
  cartoKey: string | null;
  units: Units;
  userLocation: { lat: number; lon: number } | null;
  overheadRadiusNm: number | null;
  initialView: { lat: number; lon: number; zoom: number };
  onSelect: (hex: string | null) => void;
  onAirport: (code: string) => void;
  onBounds: (b: ViewBounds) => void;
  /** Estimated position of a flight no receiver can hear (drawn as a dashed "ghost" plane). */
  ghost: { lat: number; lon: number; track: number; label: string; live?: boolean; hidePlane?: boolean; origin: [number, number]; destination: [number, number] } | null;
  /** Estimated positions of flights out of receiver coverage (dashed outline icons). */
  estimated: EstimatedAircraft[];
  onEstimated: (e: EstimatedAircraft) => void;
}

interface TileSpec {
  url: string;
  attribution: string;
  subdomains?: string;
  maxNativeZoom?: number;
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
const OSM: TileSpec = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxNativeZoom: 19 };

/** Keyless tile providers: [primary, fallback] base layers plus an optional label overlay. */
const TILES: Record<MapStyle, { base: TileSpec[]; labels?: TileSpec }> = {
  dark: {
    base: [{ url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxNativeZoom: 16 }, OSM],
    labels: { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, attribution: '', maxNativeZoom: 16 },
  },
  light: {
    base: [{ url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxNativeZoom: 16 }, OSM],
    labels: { url: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, attribution: '', maxNativeZoom: 16 },
  },
  satellite: {
    base: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', maxNativeZoom: 18 }, OSM],
    labels: { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, attribution: '', maxNativeZoom: 18 },
  },
  terrain: {
    base: [
      { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap', subdomains: 'abc', maxNativeZoom: 17 },
      { url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxNativeZoom: 18 },
    ],
  },
};

/** With a CARTO key, the dark/light styles use CARTO first and keep Esri/OSM as fallbacks. */
function tilesFor(style: MapStyle, cartoKey: string | null) {
  const cfg = TILES[style];
  if (!cartoKey || (style !== 'dark' && style !== 'light')) return cfg;
  const carto: TileSpec = {
    url: `https://{s}.basemaps.cartocdn.com/rastertiles/${style === 'dark' ? 'dark_all' : 'voyager'}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cartoKey)}`,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxNativeZoom: 19,
  };
  // CARTO tiles already include place labels, so no separate label overlay.
  return { base: [carto, ...cfg.base] };
}

const SHAPES = {
  jet: 'M12 1.5c.9 0 1.5.9 1.5 2.2v5.6l8 4.7v2l-8-2.4v4.8l2.4 1.8V22L12 21l-3.9 1v-1.8l2.4-1.8v-4.8l-8 2.4v-2l8-4.7V3.7c0-1.3.6-2.2 1.5-2.2z',
  light: 'M12 2c.7 0 1.2.6 1.2 1.5V8l9 1.2v2l-9 .6v6l2.8 1.4V21L12 20.3 8 21v-1.8l2.8-1.4v-6l-9-.6v-2l9-1.2V3.5C10.8 2.6 11.3 2 12 2z',
  heli: 'M12 5a3 3 0 0 1 3 3v5a3 3 0 0 1-2 2.8V21h-2v-5.2A3 3 0 0 1 9 13V8a3 3 0 0 1 3-3zM2 7.5h20v1H2zM11.5 1h1v6h-1z',
  mil: 'M12 1l1.6 5.5v3L22 15v2l-8.4-2.2v4.4L16 21v1.5l-4-.9-4 .9V21l2.4-1.8v-4.4L2 17v-2l8.4-5.5v-3z',
};

function iconHtml(a: Aircraft, selected: boolean, watched: boolean) {
  const k = kindOf(a);
  const shape = k === 'heli' ? SHAPES.heli : k === 'military' ? SHAPES.mil : k === 'light' ? SHAPES.light : SHAPES.jet;
  const size = a.category === 'A5' ? 30 : k === 'light' || k === 'heli' ? 20 : 25;
  const color = altColor(a);
  const cls = ['ac', selected && 'ac-selected', watched && 'ac-watched', isEmergency(a) && 'ac-emergency'].filter(Boolean).join(' ');
  return {
    size,
    html: `<div class="${cls}" style="--sz:${size}px"><svg class="ac-rot" viewBox="0 0 24 24" width="${size}" height="${size}" style="transform:rotate(${a.track ?? 0}deg)"><path d="${shape}" fill="${color}"/></svg><span class="ac-label">${a.callsign ?? a.reg ?? ''}</span></div>`,
  };
}

/** Position advanced along its track by the age of the report plus `extraSec`. */
function extrapolate(a: Aircraft, extraSec: number): [number, number] {
  if (!a.gs || a.gs < 3 || a.track === null) return [a.lat, a.lon];
  // Cruising aircraft keep a steady track, so keep extrapolating through short signal gaps.
  const dt = Math.min(a.gs > 150 && !a.onGround ? 300 : 45, extraSec + (a.seen ?? 0));
  return project(a.lat, a.lon, a.track, (a.gs * dt) / 3600);
}

interface Tracked {
  data: Aircraft;
  marker: L.Marker;
  key: string;
}

const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer[]>([]);
  const layer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, Tracked>());
  const overlay = useRef<L.LayerGroup | null>(null);
  const airportLayer = useRef<L.LayerGroup | null>(null);
  const userLayer = useRef<L.LayerGroup | null>(null);
  const ghostLayer = useRef<L.LayerGroup | null>(null);
  const estLayer = useRef<L.LayerGroup | null>(null);
  const canvasLayer = useRef<PlaneCanvasLayer | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lon, zoom) => map.current?.flyTo([lat, lon], zoom ?? Math.max(map.current.getZoom(), 8), { duration: 1.2 }),
    fitPoints: (pts) => {
      if (pts.length) map.current?.flyToBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 9, duration: 1.2 });
    },
    getCenter: () => {
      const c = map.current!.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.current!.getZoom() };
    },
  }));

  // ---------------------------------------------------------------- init
  useEffect(() => {
    if (!el.current || map.current) return;
    const { initialView } = propsRef.current;
    const m = L.map(el.current, {
      center: [initialView.lat, initialView.lon],
      zoom: initialView.zoom,
      zoomControl: false,
      worldCopyJump: true,
      preferCanvas: false,
      minZoom: 2,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(m);
    map.current = m;
    // Place labels above tiles but beneath aircraft markers.
    const labels = m.createPane('labels');
    labels.style.zIndex = '350';
    labels.style.pointerEvents = 'none';
    layer.current = L.layerGroup().addTo(m);
    overlay.current = L.layerGroup().addTo(m);
    airportLayer.current = L.layerGroup().addTo(m);
    userLayer.current = L.layerGroup().addTo(m);
    ghostLayer.current = L.layerGroup().addTo(m);
    estLayer.current = L.layerGroup().addTo(m);
    const cv = new PlaneCanvasLayer(SHAPES, extrapolate);
    cv.addTo(m);
    canvasLayer.current = cv;

    // Canvas-drawn aircraft: hover tooltip + click to select.
    const tip = L.tooltip({ direction: 'top', offset: [0, -10], className: 'ac-tip' });
    let hovered: string | null = null;
    m.on('mousemove', (e: L.LeafletMouseEvent) => {
      const a = cv.hit(e.containerPoint);
      const container = m.getContainer();
      if (!a) {
        if (hovered) {
          hovered = null;
          m.closeTooltip(tip);
          container.style.cursor = '';
        }
        return;
      }
      container.style.cursor = 'pointer';
      if (hovered === a.hex) return;
      hovered = a.hex;
      const u = propsRef.current.units;
      tip
        .setLatLng(m.containerPointToLatLng(e.containerPoint))
        .setContent(`<b>${a.callsign ?? a.reg ?? a.hex.toUpperCase()}</b> ${a.type ?? ''}<br/>${fmtAlt(a.alt, u, a.onGround)} · ${fmtSpeed(a.gs, u)}`);
      m.openTooltip(tip);
    });

    const emit = () => {
      const b = m.getBounds();
      const z = m.getZoom();
      el.current?.classList.toggle('show-labels', z >= 9);
      el.current?.classList.toggle('show-est-labels', z >= 7);
      propsRef.current.onBounds({ n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest(), zoom: z });
    };
    m.on('moveend', emit);
    m.on('click', (e: L.LeafletMouseEvent) => {
      const a = canvasLayer.current?.hit(e.containerPoint);
      propsRef.current.onSelect(a ? a.hex : null);
    });
    emit();

    // Smoothly extrapolate positions between data refreshes (dead reckoning).
    const timer = setInterval(() => {
      const now = Date.now();
      const received = propsRef.current.receivedAt;
      for (const t of markers.current.values()) {
        const a = t.data;
        if (!a.gs || a.track === null || a.gs < 3) continue;
        t.marker.setLatLng(extrapolate(a, (now - received) / 1000));
      }
      canvasLayer.current?.redraw();
    }, 1000);

    return () => {
      clearInterval(timer);
      m.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  // ---------------------------------------------------------------- tiles (with automatic fallback)
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    tiles.current.forEach((t) => t.remove());
    const cfg = tilesFor(props.mapStyle, props.cartoKey);
    const make = (spec: TileSpec, pane?: string) =>
      L.tileLayer(spec.url, {
        attribution: spec.attribution,
        subdomains: spec.subdomains ?? 'abc',
        maxNativeZoom: spec.maxNativeZoom ?? 18,
        maxZoom: 19,
        ...(pane ? { pane } : {}),
      });
    const base = make(cfg.base[0]);
    // Swap to the next provider if the primary keeps failing.
    let errors = 0;
    let idx = 0;
    base.on('tileerror', () => {
      if (++errors < 6 || idx >= cfg.base.length - 1) return;
      idx++;
      errors = 0;
      const next = cfg.base[idx];
      m.attributionControl.removeAttribution(cfg.base[idx - 1].attribution).addAttribution(next.attribution);
      base.options.subdomains = next.subdomains ?? 'abc';
      base.setUrl(next.url);
    });
    const layers = [base.addTo(m)];
    if (cfg.labels) layers.push(make(cfg.labels, 'labels').addTo(m));
    tiles.current = layers;
    el.current?.setAttribute('data-style', props.mapStyle);
  }, [props.mapStyle, props.cartoKey]);

  // ---------------------------------------------------------------- aircraft markers
  useEffect(() => {
    const lg = layer.current;
    if (!lg) return;
    const next = new Set<string>();
    const { selectedHex, watched } = props;
    // Busy views: everything on the canvas except aircraft that need DOM effects (selection
    // ring, starred glow, emergency pulse, labels on hover).
    const canvasMode = props.aircraft.length > CANVAS_THRESHOLD;
    const special = (a: Aircraft) => a.hex === selectedHex || watched.has(a.hex) || isEmergency(a);
    const domList = canvasMode ? props.aircraft.filter(special) : props.aircraft;
    canvasLayer.current?.setData(canvasMode ? props.aircraft.filter((a) => !special(a)) : [], props.receivedAt);
    for (const a of domList) {
      next.add(a.hex);
      const selected = a.hex === selectedHex;
      const isWatched = watched.has(a.hex);
      // Re-render the icon only when something visible changed.
      const key = `${Math.round(a.track ?? 0)}|${Math.round((a.alt ?? 0) / 500)}|${a.onGround}|${selected}|${isWatched}|${a.squawk}|${a.callsign}`;
      const existing = markers.current.get(a.hex);
      if (existing) {
        existing.data = a;
        existing.marker.setLatLng(extrapolate(a, 0));
        if (existing.key !== key) {
          const ic = iconHtml(a, selected, isWatched);
          existing.marker.setIcon(L.divIcon({ html: ic.html, className: 'ac-icon', iconSize: [ic.size, ic.size], iconAnchor: [ic.size / 2, ic.size / 2] }));
          existing.marker.setZIndexOffset(selected ? 2000 : isWatched || isEmergency(a) ? 1000 : 0);
          existing.key = key;
        }
      } else {
        const ic = iconHtml(a, selected, isWatched);
        const marker = L.marker(extrapolate(a, 0), {
          icon: L.divIcon({ html: ic.html, className: 'ac-icon', iconSize: [ic.size, ic.size], iconAnchor: [ic.size / 2, ic.size / 2] }),
          zIndexOffset: selected ? 2000 : isWatched || isEmergency(a) ? 1000 : 0,
          keyboard: false,
        });
        const tracked: Tracked = { data: a, marker, key };
        marker.bindTooltip(
          () => {
            const d = tracked.data;
            const u = propsRef.current.units;
            return `<b>${d.callsign ?? d.reg ?? d.hex.toUpperCase()}</b> ${d.type ?? ''}<br/>${fmtAlt(d.alt, u, d.onGround)} · ${fmtSpeed(d.gs, u)}${d.source === 'flightaware' ? '<br/><i>via FlightAware</i>' : ''}`;
          },
          { direction: 'top', offset: [0, -10], className: 'ac-tip' },
        );
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          propsRef.current.onSelect(a.hex);
        });
        marker.addTo(lg);
        markers.current.set(a.hex, tracked);
      }
    }
    for (const [hex, t] of markers.current) {
      if (!next.has(hex)) {
        lg.removeLayer(t.marker);
        markers.current.delete(hex);
      }
    }
  }, [props.aircraft, props.selectedHex, props.watched]);

  // ---------------------------------------------------------------- selected trail + route
  useEffect(() => {
    const ov = overlay.current;
    if (!ov) return;
    ov.clearLayers();
    const { trail, route, selectedHex } = props;
    if (!selectedHex) return;
    const sel = props.aircraft.find((a) => a.hex === selectedHex);
    const here: [number, number] | null = sel ? [sel.lat, sel.lon] : trail.length ? [trail[trail.length - 1].lat, trail[trail.length - 1].lon] : null;

    if (route?.origin && here) {
      L.polyline(greatCircle(route.origin, here, 48), { color: '#94a3b8', weight: 2, opacity: 0.45 }).addTo(ov);
    }
    if (route?.destination && here) {
      L.polyline(greatCircle(here, route.destination, 64), { color: '#38bdf8', weight: 2, opacity: 0.85, dashArray: '6 8' }).addTo(ov);
    }
    for (const [pt, label] of [
      [route?.origin, 'origin'],
      [route?.destination, 'destination'],
    ] as const) {
      if (pt) L.circleMarker(pt, { radius: 6, color: '#fff', weight: 2, fillColor: label === 'origin' ? '#94a3b8' : '#38bdf8', fillOpacity: 1 }).addTo(ov);
    }
    // Altitude-coloured breadcrumb trail.
    for (let i = 1; i < trail.length; i++) {
      const p = trail[i - 1];
      const q = trail[i];
      L.polyline(
        [
          [p.lat, p.lon],
          [q.lat, q.lon],
        ],
        { color: altColor({ alt: q.alt, onGround: false, emergency: null, squawk: null }), weight: 3, opacity: 0.9 },
      ).addTo(ov);
    }
  }, [props.trail, props.route, props.selectedHex, props.aircraft]);

  // ---------------------------------------------------------------- airports
  useEffect(() => {
    const m = map.current;
    const al = airportLayer.current;
    if (!m || !al) return;
    const render = () => {
      al.clearLayers();
      const z = m.getZoom();
      if (!propsRef.current.showAirports || z < 3) return;
      const b = m.getBounds().pad(0.1);
      // Major airports from zoom 3, medium ones from zoom 7; keep the marker count sane.
      const list = propsRef.current.airports.filter((ap) => (ap.large ? true : z >= 7) && b.contains([ap.lat, ap.lon]));
      const shown = list.length > 350 ? list.filter((ap) => ap.large).slice(0, 350) : list;
      const compact = z < 6;
      for (const ap of shown) {
        const cls = `ap ${ap.large ? 'ap-large' : 'ap-medium'} ${compact ? 'ap-compact' : ''}`;
        const mk = L.marker([ap.lat, ap.lon], {
          icon: L.divIcon({
            className: 'ap-icon',
            html: `<div class="${cls}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M12 4.5c.5 0 .9.5.9 1.2v4.1l5.4 3.2v1.5l-5.4-1.6v3.3l1.6 1.2v1.2L12 18l-2.5.6v-1.2l1.6-1.2v-3.3l-5.4 1.6V13l5.4-3.2V5.7c0-.7.4-1.2.9-1.2z"/></svg><span>${ap.iata}</span></div>`,
            iconSize: [compact ? 16 : 52, 18],
            iconAnchor: [compact ? 8 : 9, 9],
          }),
          zIndexOffset: -500,
          keyboard: false,
        });
        mk.bindTooltip(`<b>${ap.iata}</b> · ${ap.name}`, { direction: 'top', className: 'ac-tip' });
        mk.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          propsRef.current.onAirport(ap.iata);
        });
        mk.addTo(al);
      }
    };
    render();
    m.on('moveend', render);
    return () => {
      m.off('moveend', render);
    };
  }, [props.airports, props.showAirports]);

  // ---------------------------------------------------------------- estimated-aircraft layer
  useEffect(() => {
    const el = estLayer.current;
    if (!el) return;
    el.clearLayers();
    for (const e of props.estimated) {
      const color = altColor({ alt: e.alt, onGround: false, emergency: null, squawk: null });
      const mins = Math.round(e.silentSec / 60);
      const label = e.flightNumber ?? e.callsign;
      L.marker([e.lat, e.lon], {
        icon: L.divIcon({
          className: 'ac-icon',
          html: `<div class="ac ac-est" style="--sz:24px"><svg class="ac-rot" viewBox="0 0 24 24" width="24" height="24" style="transform:rotate(${e.track}deg)"><path d="${SHAPES.jet}" fill="${color}" fill-opacity="0.35" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="2 1.5"/></svg><span class="ac-label">${label} · est.</span></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        zIndexOffset: -100,
        keyboard: false,
      })
        .bindTooltip(
          `<b>${label}</b> ${e.type ?? ''} — <i>estimated</i><br/>` +
            (e.method === 'flightaware'
              ? `Position from ${e.lastSeenSource}, ${mins < 1 ? 'just now' : `${mins} min ago`} — no free receiver hears it<br/>`
              : e.method === 'schedule'
              ? `${e.silentSec < 0 ? 'Not heard by any receiver' : `No signal for ${mins} min`} — placed by its schedule (${e.lastSeenSource})<br/>`
              : `No signal for ${mins} min (last heard by ${e.lastSeenSource})<br/>`) +
            (e.method !== 'heading' && e.destination
              ? `Moving along its route to ${e.destination.iata ?? e.destination.icao}${e.etaMinutes != null ? ` · lands in ~${e.etaMinutes} min` : ''}`
              : 'Following its last heading (route unknown)') +
            (e.verified ? '<br/>✓ FlightAware confirms it is still airborne' : ''),
          { direction: 'top', offset: [0, -10], className: 'ac-tip' },
        )
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          propsRef.current.onEstimated(e);
        })
        .addTo(el);
    }
  }, [props.estimated]);

  // ---------------------------------------------------------------- estimated ("ghost") flight
  useEffect(() => {
    const gl = ghostLayer.current;
    if (!gl) return;
    gl.clearLayers();
    const g = props.ghost;
    if (!g) return;
    const here: [number, number] = [g.lat, g.lon];
    L.polyline(greatCircle(g.origin, here, 48), { color: '#94a3b8', weight: 2, opacity: 0.45 }).addTo(gl);
    L.polyline(greatCircle(here, g.destination, 64), { color: '#f59e0b', weight: 2, opacity: 0.8, dashArray: '6 8' }).addTo(gl);
    for (const pt of [g.origin, g.destination]) L.circleMarker(pt, { radius: 6, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 }).addTo(gl);
    if (g.hidePlane) return;
    L.marker(here, {
      icon: L.divIcon({
        className: 'ac-icon',
        html: `<div class="ac ac-ghost" style="--sz:28px"><svg class="ac-rot" viewBox="0 0 24 24" width="28" height="28" style="transform:rotate(${g.track}deg)"><path d="${SHAPES.jet}" fill="rgba(245,158,11,0.25)" stroke="#f59e0b" stroke-width="1" stroke-dasharray="2 1.5"/></svg><span class="ac-label">${g.label} · ${g.live ? 'live via FA' : 'est.'}</span></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      zIndexOffset: 2500,
    })
      .bindTooltip(g.live ? `<b>${g.label}</b> — live position from FlightAware<br/>The free networks can't hear it` : `<b>${g.label}</b> — estimated position<br/>No live signal`, { direction: 'top', offset: [0, -10], className: 'ac-tip' })
      .addTo(gl);
  }, [props.ghost]);

  // ---------------------------------------------------------------- user location
  useEffect(() => {
    const ul = userLayer.current;
    if (!ul) return;
    ul.clearLayers();
    if (!props.userLocation) return;
    const p: [number, number] = [props.userLocation.lat, props.userLocation.lon];
    if (props.overheadRadiusNm) {
      L.circle(p, { radius: props.overheadRadiusNm * 1852, color: '#38bdf8', weight: 1, fillOpacity: 0.05, dashArray: '4 6' }).addTo(ul);
    }
    L.marker(p, { icon: L.divIcon({ className: 'me-icon', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(ul);
  }, [props.userLocation, props.overheadRadiusNm]);

  return <div ref={el} className="map" />;
});

export default MapView;
