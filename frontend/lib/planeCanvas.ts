import L from 'leaflet';
import type { Aircraft } from './types';
import { altColor, isEmergency, kindOf } from './flight';

type Extrapolate = (a: Aircraft, extraSec: number) => [number, number];

interface Drawn {
  a: Aircraft;
  x: number;
  y: number;
}

/**
 * Draws thousands of aircraft on one <canvas> instead of one DOM marker each — needed for
 * zoomed-out views (5,000+ aircraft). Same rotated, altitude-coloured plane glyphs as the
 * DOM markers; supports hit-testing for hover/click.
 */
export class PlaneCanvasLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private drawn: Drawn[] = [];
  private data: Aircraft[] = [];
  private receivedAt = Date.now();
  private readonly shapes: Record<string, Path2D>;

  constructor(
    shapes: { jet: string; light: string; heli: string; mil: string },
    private readonly extrapolate: Extrapolate,
  ) {
    super();
    this.shapes = {
      jet: new Path2D(shapes.jet),
      light: new Path2D(shapes.light),
      heli: new Path2D(shapes.heli),
      mil: new Path2D(shapes.mil),
    };
  }

  setData(list: Aircraft[], receivedAt: number) {
    this.data = list;
    this.receivedAt = receivedAt;
    this.redraw();
  }

  onAdd(map: L.Map) {
    this.canvas = L.DomUtil.create('canvas', 'plane-canvas leaflet-zoom-hide') as HTMLCanvasElement;
    this.canvas.style.pointerEvents = 'none'; // the map handles clicks; we hit-test ourselves
    this.ctx = this.canvas.getContext('2d');
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend zoomend resize viewreset', this.redraw, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map) {
    map.off('moveend zoomend resize viewreset', this.redraw, this);
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.drawn = [];
    return this;
  }

  redraw() {
    const map = this._map;
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!map || !canvas || !ctx) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    // Keep the canvas aligned with the viewport while the map pane is panned.
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const zoom = map.getZoom();
    const scale = zoom <= 3 ? 0.55 : zoom <= 5 ? 0.7 : zoom <= 7 ? 0.85 : 1;
    const labels = zoom >= 9;
    const elapsed = (Date.now() - this.receivedAt) / 1000;
    const out: Drawn[] = [];
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    for (const a of this.data) {
      const [lat, lon] = this.extrapolate(a, elapsed);
      const p = map.latLngToContainerPoint([lat, lon]);
      if (p.x < -20 || p.y < -20 || p.x > size.x + 20 || p.y > size.y + 20) continue;
      const k = kindOf(a);
      const px = (a.category === 'A5' ? 28 : k === 'light' || k === 'heli' ? 18 : 23) * scale;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(((a.track ?? 0) * Math.PI) / 180);
      ctx.scale(px / 24, px / 24);
      ctx.translate(-12, -12);
      const path = k === 'heli' ? this.shapes.heli : k === 'military' ? this.shapes.mil : k === 'light' ? this.shapes.light : this.shapes.jet;
      ctx.fillStyle = altColor(a);
      ctx.fill(path);
      ctx.stroke(path);
      ctx.restore();
      if (labels && (a.callsign || a.reg)) {
        ctx.fillStyle = '#e2e8f0';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 3;
        ctx.fillText(a.callsign ?? a.reg ?? '', p.x + px / 2 + 3, p.y + 3);
        ctx.shadowBlur = 0;
      }
      if (isEmergency(a)) {
        ctx.beginPath();
        ctx.strokeStyle = '#ef4444';
        ctx.arc(p.x, p.y, px * 0.75, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      }
      out.push({ a, x: p.x, y: p.y });
    }
    this.drawn = out;
  }

  /** Aircraft drawn nearest to a container point (within `radius` px), if any. */
  hit(point: L.Point, radius = 10): Aircraft | null {
    let best: Drawn | null = null;
    let bestD = radius * radius;
    for (const d of this.drawn) {
      const dx = d.x - point.x;
      const dy = d.y - point.y;
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best?.a ?? null;
  }
}
