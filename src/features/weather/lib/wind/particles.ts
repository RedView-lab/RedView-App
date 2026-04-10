import type { Map as MapboxMap } from 'mapbox-gl';
import {
  clamp, lerp,
  MAX_DELTA_SECONDS, DIRECTION_SMOOTH, FADE_IN_RATE,
  MAX_PARTICLE_ALLOC, TRAIL_LENGTH, DROP_RATE, DROP_RATE_BUMP,
  EQUATORIAL_CIRCUMFERENCE,
  adaptiveParticleCount, adaptiveLifetime, adaptiveSimulationScale,
} from './types';
import type { WindBounds } from './types';
import type { WindSampler } from './sampler';

// ── Particle simulation engine ─────────────────────────────────────────
// Owns all per-particle SOA arrays. Handles advection, lifecycle,
// viewport redistribution, and screen-space overlap resolution.

export class ParticleSystem {
  // SOA (Structure-of-Arrays) layout for cache-friendly iteration
  positions = new Float32Array(MAX_PARTICLE_ALLOC * 2);
  ages = new Float32Array(MAX_PARTICLE_ALLOC);
  lives = new Float32Array(MAX_PARTICLE_ALLOC);
  speeds = new Float32Array(MAX_PARTICLE_ALLOC);
  windU = new Float32Array(MAX_PARTICLE_ALLOC);
  windV = new Float32Array(MAX_PARTICLE_ALLOC);
  dirU = new Float32Array(MAX_PARTICLE_ALLOC);        // displacement direction (kept for fallback)
  dirV = new Float32Array(MAX_PARTICLE_ALLOC);
  fade = new Float32Array(MAX_PARTICLE_ALLOC);       // 0→1 fade-in
  visible = new Uint8Array(MAX_PARTICLE_ALLOC);       // 1 = passes spacing filter

  // Trail ring buffers — store Mercator coords directly (avoids fromLngLat in geometry builder)
  trailX = new Float32Array(MAX_PARTICLE_ALLOC * TRAIL_LENGTH);
  trailY = new Float32Array(MAX_PARTICLE_ALLOC * TRAIL_LENGTH);
  trailZ = new Float32Array(MAX_PARTICLE_ALLOC * TRAIL_LENGTH);
  trailHead = new Uint8Array(MAX_PARTICLE_ALLOC);    // write index into ring buffer
  trailCount = new Uint8Array(MAX_PARTICLE_ALLOC);   // valid entries (0 → TRAIL_LENGTH)

  count = 0;
  activeCount = 0; // visible arrows after overlap resolve

  private lastFrameTime = 0;
  private lastVpCenterLng = 0;
  private lastVpCenterLat = 0;
  private lastVpZoom = -1;

  /** Initialize particle pool based on current viewport. */
  configure(map: MapboxMap, _bounds: WindBounds): void {
    const b = map.getBounds();
    if (!b) return;

    const vpW = b.getEast() - b.getWest();
    const vpH = b.getNorth() - b.getSouth();
    const zoom = map.getZoom();
    this.count = adaptiveParticleCount(zoom, vpW, vpH);
    this.activeCount = this.count;

    for (let i = 0; i < this.count; i++) {
      this.respawnInViewport(i, b.getWest(), b.getEast(), b.getSouth(), b.getNorth(), true);
    }

    this.lastVpCenterLng = (b.getWest() + b.getEast()) / 2;
    this.lastVpCenterLat = (b.getSouth() + b.getNorth()) / 2;
    this.lastVpZoom = zoom;
    this.lastFrameTime = 0;
  }

  /**
   * Redistribute particles when the viewport pans or zooms.
   * Out-of-viewport particles are recycled inside with fade-in.
   */
  redistribute(map: MapboxMap, _bounds: WindBounds): void {
    if (this.count === 0) return;
    const b = map.getBounds();
    if (!b) return;

    const vpWest = b.getWest();
    const vpEast = b.getEast();
    const vpSouth = b.getSouth();
    const vpNorth = b.getNorth();
    const vpW = vpEast - vpWest;
    const vpH = vpNorth - vpSouth;
    if (vpW <= 0 || vpH <= 0) return;

    const vpCenterLng = (vpWest + vpEast) / 2;
    const vpCenterLat = (vpSouth + vpNorth) / 2;
    const vpZoom = map.getZoom();

    const shiftLng = Math.abs(vpCenterLng - this.lastVpCenterLng) / vpW;
    const shiftLat = Math.abs(vpCenterLat - this.lastVpCenterLat) / vpH;
    const zoomDelta = Math.abs(vpZoom - this.lastVpZoom);

    if (shiftLng < 0.05 && shiftLat < 0.05 && zoomDelta < 0.3) return;

    this.lastVpCenterLng = vpCenterLng;
    this.lastVpCenterLat = vpCenterLat;
    this.lastVpZoom = vpZoom;

    // Adjust count for new zoom level
    const newCount = adaptiveParticleCount(vpZoom, vpW, vpH);
    if (newCount > this.count) {
      for (let i = this.count; i < newCount; i++) {
        this.respawnInViewport(i, vpWest, vpEast, vpSouth, vpNorth, false);
      }
    }
    this.count = newCount;

    // Recycle out-of-viewport particles (with 10% margin)
    const mLng = vpW * 0.1;
    const mLat = vpH * 0.1;

    for (let i = 0; i < this.count; i++) {
      const pi = i * 2;
      const lng = this.positions[pi];
      const lat = this.positions[pi + 1];
      const inVp =
        lng >= vpWest - mLng && lng <= vpEast + mLng &&
        lat >= vpSouth - mLat && lat <= vpNorth + mLat;
      if (!inVp) {
        this.respawnInViewport(i, vpWest, vpEast, vpSouth, vpNorth, false);
      }
    }
  }

  /** Advance all particles by one time step. */
  advance(now: number, map: MapboxMap, sampler: WindSampler, bounds: WindBounds): void {
    if (this.lastFrameTime === 0) {
      this.lastFrameTime = now;
      return;
    }

    const dt = clamp((now - this.lastFrameTime) / 1000, 0, MAX_DELTA_SECONDS);
    this.lastFrameTime = now;
    if (dt <= 0) return;

    const metersPerDegreeLat = 111_320;
    const simScale = adaptiveSimulationScale(map.getZoom());

    for (let i = 0; i < this.count; i++) {
      const pi = i * 2;
      let lng = this.positions[pi];
      let lat = this.positions[pi + 1];

      // Smooth fade-in
      if (this.fade[i] < 1) {
        this.fade[i] = Math.min(1, this.fade[i] + dt * FADE_IN_RATE);
      }

      // Age → respawn when expired
      this.ages[i] += dt;
      if (this.ages[i] >= this.lives[i]) {
        this.respawnFromMap(i, map);
        continue;
      }

      // Sample wind field
      const wind = sampler.sample(lng, lat);

      // Temporal smoothing to prevent direction jitter
      const prev = this.speeds[i];
      if (prev > 0.01 && this.fade[i] > 0.1) {
        this.speeds[i] = lerp(prev, wind.speed, DIRECTION_SMOOTH);
        this.windU[i] = lerp(this.windU[i], wind.u, DIRECTION_SMOOTH);
        this.windV[i] = lerp(this.windV[i], wind.v, DIRECTION_SMOOTH);
      } else {
        this.speeds[i] = wind.speed;
        this.windU[i] = wind.u;
        this.windV[i] = wind.v;
      }

      // Advect position
      const mpdLng = Math.max(1, Math.cos(lat * Math.PI / 180) * metersPerDegreeLat);
      lng += (this.windU[i] * dt * simScale) / mpdLng;
      lat += (this.windV[i] * dt * simScale) / metersPerDegreeLat;

      // Out of both data bounds and viewport → recycle
      if (!isInsideBounds(lng, lat, bounds) && !isInViewport(lng, lat, map)) {
        this.respawnFromMap(i, map);
        continue;
      }

      this.positions[pi] = lng;
      this.positions[pi + 1] = lat;

      // Record trail position as Mercator coords (pre-converted — avoids 30K fromLngLat in geometry)
      const cosLat = Math.cos(lat * Math.PI / 180);
      const metersPerPx = EQUATORIAL_CIRCUMFERENCE * cosLat / (512 * Math.pow(2, map.getZoom()));
      const elev = map.queryTerrainElevation?.([lng, lat]) ?? 0;
      const altitude = elev + clamp(metersPerPx * 3, 10, 40);
      // Inline Mercator conversion (no object allocation)
      const mcX = (180 + lng) / 360;
      const mcY = (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)))) / 360;
      const mcZ = altitude / (EQUATORIAL_CIRCUMFERENCE * Math.max(1e-6, cosLat));
      const ringBase = i * TRAIL_LENGTH;
      const head = this.trailHead[i];
      this.trailX[ringBase + head] = mcX;
      this.trailY[ringBase + head] = mcY;
      this.trailZ[ringBase + head] = mcZ;
      this.trailHead[i] = (head + 1) % TRAIL_LENGTH;
      if (this.trailCount[i] < TRAIL_LENGTH) this.trailCount[i]++;

      // Drop-rate random respawn (wind-layer style organic flow)
      const speedT = clamp(this.speeds[i] / 25, 0, 1);
      if (Math.random() < DROP_RATE + speedT * DROP_RATE_BUMP) {
        this.respawnFromMap(i, map);
      }
    }
  }

  // ── Respawn helpers ────────────────────────────────────────────────

  private respawnFromMap(index: number, map: MapboxMap): void {
    const b = map.getBounds();
    if (b) {
      this.respawnInViewport(index, b.getWest(), b.getEast(), b.getSouth(), b.getNorth(), false);
    }
  }

  private respawnInViewport(
    i: number,
    west: number, east: number, south: number, north: number,
    randomAge: boolean,
  ): void {
    const pi = i * 2;
    this.positions[pi] = lerp(west, east, Math.random());
    this.positions[pi + 1] = lerp(south, north, Math.random());

    // Speed-adaptive lifetime (set after first wind sample; default mid-range)
    const baseLife = adaptiveLifetime(this.speeds[i] || 5);
    // ±20% jitter to prevent synchronized respawn waves
    const jitter = 0.8 + Math.random() * 0.4;
    this.lives[i] = baseLife * jitter;

    this.ages[i] = randomAge ? Math.random() * this.lives[i] : 0;
    this.speeds[i] = 0;
    this.windU[i] = 0;
    this.windV[i] = 0;
    this.dirU[i] = 0;
    this.dirV[i] = 0;
    this.fade[i] = randomAge ? Math.min(1, Math.random() + 0.3) : 0;
    this.trailCount[i] = 0;
    this.trailHead[i] = 0;
  }
}

// ── Boundary helpers ───────────────────────────────────────────────────

function isInsideBounds(lng: number, lat: number, bounds: WindBounds): boolean {
  return lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

function isInViewport(lng: number, lat: number, map: MapboxMap): boolean {
  const b = map.getBounds();
  if (!b) return false;
  const w = b.getEast() - b.getWest();
  const h = b.getNorth() - b.getSouth();
  const mLng = w * 0.1;
  const mLat = h * 0.1;
  return (
    lng >= b.getWest() - mLng && lng <= b.getEast() + mLng &&
    lat >= b.getSouth() - mLat && lat <= b.getNorth() + mLat
  );
}
