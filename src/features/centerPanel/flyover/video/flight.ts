import { APPROACH_CURVE } from '../config';
import { toDegrees, toRadians, wrapPi } from '../engine/geo';
import { smootherstep } from '../engine/springs';

/** Vue Mapbox de haut niveau (centre Mercator [0, 1], zoom, inclinaison, cap). */
export interface MapView {
  x: number;
  y: number;
  zoom: number;
  pitchDeg: number;
  bearingDeg: number;
}

const TILE_SIZE = 512;

/**
 * Survol déterministe d'une vue à l'autre : le chemin optimal de van Wijk &
 * Nuij (« Smooth and efficient zooming and panning », celui de `flyTo`),
 * évalué à une fraction de temps donnée au lieu de l'horloge de Mapbox.
 * Inclinaison et cap (plus court chemin) suivent la même courbe d'easing.
 */
export class MapFlight {
  private readonly from: MapView;
  private readonly to: MapView;
  private readonly bearingDelta: number;
  private readonly rho = APPROACH_CURVE;
  private readonly w0: number;
  private readonly u1: number;
  private readonly r0: number;
  private readonly S: number;
  private readonly degenerate: boolean;

  constructor(from: MapView, to: MapView, viewport: { width: number; height: number }) {
    this.from = from;
    this.to = to;
    this.bearingDelta = toDegrees(wrapPi(toRadians(to.bearingDeg - from.bearingDeg)));
    const rho2 = this.rho * this.rho;
    const worldSize = TILE_SIZE * 2 ** from.zoom;
    const w0 = Math.max(viewport.width, viewport.height, 1);
    const w1 = w0 / 2 ** (to.zoom - from.zoom);
    const u1 = Math.hypot(to.x - from.x, to.y - from.y) * worldSize;
    this.w0 = w0;
    this.u1 = u1;
    const r = (i: 0 | 1) => {
      const w = i ? w1 : w0;
      const b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * w * rho2 * u1);
      return Math.log(Math.sqrt(b * b + 1) - b);
    };
    this.r0 = u1 > 1e-6 ? r(0) : 0;
    const S = u1 > 1e-6 ? (r(1) - this.r0) / this.rho : Number.NaN;
    this.degenerate = !(Number.isFinite(S) && S > 0);
    this.S = this.degenerate ? Math.abs(Math.log(w1 / w0)) / this.rho : S;
  }

  /** Vue à la fraction de temps `t` ∈ [0, 1] (easing smootherstep : départ et arrivée sans à-coup). */
  viewAt(t: number, out: MapView): MapView {
    const k = smootherstep(t);
    const { from, to } = this;
    if (k >= 1) {
      Object.assign(out, to);
      return out;
    }
    const s = k * this.S;
    let fraction: number;
    let zoom: number;
    if (this.degenerate) {
      // Même centre : zoom linéaire dans le temps du chemin (exponentiel en échelle, comme flyTo).
      fraction = k;
      zoom = from.zoom + (to.zoom - from.zoom) * k;
    } else {
      const rho2 = this.rho * this.rho;
      const r = this.r0 + this.rho * s;
      const w = Math.cosh(this.r0) / Math.cosh(r);
      fraction = (this.w0 * ((Math.cosh(this.r0) * Math.tanh(r) - Math.sinh(this.r0)) / rho2)) / this.u1;
      zoom = from.zoom + Math.log2(1 / w);
    }
    out.x = from.x + (to.x - from.x) * fraction;
    out.y = from.y + (to.y - from.y) * fraction;
    out.zoom = Number.isFinite(zoom) ? zoom : from.zoom + (to.zoom - from.zoom) * k;
    out.pitchDeg = from.pitchDeg + (to.pitchDeg - from.pitchDeg) * k;
    out.bearingDeg = from.bearingDeg + this.bearingDelta * k;
    return out;
  }
}
