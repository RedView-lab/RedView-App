// ============================================
// Chronométrage GPU des images du backend WebGL 2
// ============================================
//
// Avec EXT_disjoint_timer_query_webgl2 (Chrome/ANGLE sur la plupart des
// ordinateurs de bureau ; absent de Firefox), chaque passe chronométrée d'une
// image reçoit une requête TIME_ELAPSED, relue quelques images plus tard, comme
// les horodatages WebGPU (../gpuTimer.ts) : les passes de dessin pilotent le
// budget de points, la passe d'ombrage est comptée à part. Sans elle rien n'est
// mesuré (`usesQueries` faux) : le budget se fie alors au temps CPU et à la
// cadence réelle, comme en WebGPU sans `timestamp-query`.

import { TIMED_PASS } from '../gpuTimer';

const FRAME_SLOTS = 4;
const SAMPLE_BLEND = 0.35;
const TIMED_PASSES = 3;

interface TimerQueryExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface FrameSlot {
  queries: WebGLQuery[];
  /** Passes (un bit par indice) mesurées dans l'image que contient l'emplacement. */
  passes: number;
  pending: boolean;
}

export class GlFrameTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExtension | null;
  private readonly slots: FrameSlot[] = [];
  private frame: FrameSlot | null = null;
  private activePass = -1;
  private drawMs = 0;
  private shadeMs = 0;
  private hasSample = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null;
    if (!this.ext) return;
    for (let i = 0; i < FRAME_SLOTS; i++) {
      const queries: WebGLQuery[] = [];
      for (let p = 0; p < TIMED_PASSES; p++) {
        const query = gl.createQuery();
        if (query) queries.push(query);
      }
      if (queries.length === TIMED_PASSES) this.slots.push({ queries, passes: 0, pending: false });
    }
  }

  get usesQueries(): boolean {
    return this.slots.length > 0;
  }

  getFrameMs(): number {
    return this.hasSample ? this.drawMs : 0;
  }

  getShadeMs(): number {
    return this.hasSample ? this.shadeMs : 0;
  }

  /** Lit les images terminées, puis réserve un emplacement pour celle-ci ; false quand tous sont encore en vol. */
  beginFrame(): boolean {
    if (!this.ext) return false;
    this.collect();
    this.frame = this.slots.find((slot) => !slot.pending) ?? null;
    if (this.frame) this.frame.passes = 0;
    return this.frame !== null;
  }

  beginPass(pass: number): void {
    if (!this.ext || !this.frame || this.activePass >= 0) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.frame.queries[pass]!);
    this.frame.passes |= 1 << pass;
    this.activePass = pass;
  }

  endPass(): void {
    if (!this.ext || this.activePass < 0) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.activePass = -1;
  }

  endFrame(): void {
    this.endPass();
    if (this.frame && this.frame.passes !== 0) this.frame.pending = true;
    this.frame = null;
  }

  private collect(): void {
    const gl = this.gl;
    const ext = this.ext!;
    for (const slot of this.slots) {
      if (!slot.pending) continue;
      const last = [...slot.queries.keys()].reverse().find((pass) => (slot.passes & (1 << pass)) !== 0);
      if (last === undefined || !gl.getQueryParameter(slot.queries[last]!, gl.QUERY_RESULT_AVAILABLE)) continue;
      slot.pending = false;
      // Un événement disjoint (changement d'horloge, changement de contexte) annule les résultats en vol.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) continue;
      const passNs = (pass: number): number => ((slot.passes & (1 << pass)) !== 0
        ? Number(gl.getQueryParameter(slot.queries[pass]!, gl.QUERY_RESULT)) || 0
        : 0);
      const drawNs = passNs(TIMED_PASS.scene) + passNs(TIMED_PASS.edl);
      if (drawNs > 0) this.addSample(drawNs / 1e6, passNs(TIMED_PASS.shading) / 1e6);
    }
  }

  private addSample(drawMs: number, shadeMs: number): void {
    if (!Number.isFinite(drawMs) || drawMs <= 0) return;
    if (this.hasSample) {
      this.drawMs += (drawMs - this.drawMs) * SAMPLE_BLEND;
      this.shadeMs += (shadeMs - this.shadeMs) * SAMPLE_BLEND;
    } else {
      this.drawMs = drawMs;
      this.shadeMs = shadeMs;
    }
    this.hasSample = true;
  }

  destroy(): void {
    this.endPass();
    for (const slot of this.slots) for (const query of slot.queries) this.gl.deleteQuery(query);
    this.slots.length = 0;
  }
}
