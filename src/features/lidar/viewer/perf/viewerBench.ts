// ============================================
// Trajet de caméra scripté mesurant la vraie cadence d'images (?bench=orbit)
// ============================================
//
// Le viewer suit deux fois un trajet fixe (orbite d'ensemble, zoom + panoramique
// jusqu'au sol, vue rasante) : la première passe charge les nœuds en flux
// (à froid), la seconde en trouve la plupart résidents (à chaud). Chaque image
// rendue est enregistrée avec son intervalle rAF, pour que le rapport montre ce
// que voit l'utilisateur (i/s, p95, vsyncs ratées) à côté des coûts GPU/CPU mesurés.
// La caméra bouge via `setPose`, c'est-à-dire via la même notification de
// changement que les entrées souris. Les résultats arrivent dans
// `window.__rvLidarBench` et dans la console (`[LiDAR bench] {json}`), lus par
// script-test-bench/lidar-viewer-perf.

import type { CameraController, CameraPose } from '../camera';

export interface ViewerBenchFrame {
  /** Coût GPU lissé des passes de dessin (ms). */
  drawMs: number;
  /** Coût GPU lissé de la passe d'ombrage (ms). */
  shadeMs: number;
  /** Temps JS de la boucle de rendu (ms). */
  cpuMs: number;
  selectedPoints: number;
  pointBudget: number;
  /** Envois de nœuds cumulés (voir SceneLodStats.uploadedNodes). */
  uploadedNodes: number;
  renderScale: number;
}

interface ViewerBenchSegmentReport {
  segment: string;
  frames: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Part des intervalles plus longs que 1,5 période de rafraîchissement. */
  missedRatio: number;
  drawMs: number;
  shadeMs: number;
  cpuMs: number;
  points: number;
  budget: number;
  uploads: number;
}

export interface ViewerBenchResult {
  passes: Array<{ pass: string; segments: ViewerBenchSegmentReport[]; total: ViewerBenchSegmentReport }>;
  refreshMs: number;
}

interface Segment {
  name: string;
  durationMs: number;
  pose: (t: number) => CameraPose;
}

interface FrameRecord extends ViewerBenchFrame {
  intervalMs: number;
}

const PASSES = ['froid', 'chaud'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Trajet sur une scène de taille `extent` centrée sur l'origine ; la cible
 * suit le sol (`groundAt`, repère de rendu) pour que le zoom finisse au-dessus.
 */
function buildSegments(extent: number, groundAt: (x: number, z: number) => number): Segment[] {
  const overview = extent * 0.72;
  const close = extent * 0.12;
  const grazing = extent * 0.3;
  const panA = { x: extent * 0.12, z: -extent * 0.08 };
  const panB = { x: -extent * 0.1, z: extent * 0.1 };
  const target = (x: number, z: number) => ({ targetX: x, targetY: groundAt(x, z), targetZ: z });
  return [
    {
      name: 'orbite',
      durationMs: 4000,
      pose: (t) => ({ theta: Math.PI / 4 + t * (Math.PI / 2), phi: Math.PI / 3, radius: overview, ...target(0, 0) }),
    },
    {
      name: 'zoom',
      durationMs: 4000,
      pose: (t) => {
        const s = smooth(t);
        return {
          theta: (3 * Math.PI) / 4 + t * (Math.PI / 6),
          phi: lerp(Math.PI / 3, 0.9, s),
          radius: overview * Math.pow(close / overview, s),
          ...target(lerp(0, panA.x, s), lerp(0, panA.z, s)),
        };
      },
    },
    {
      name: 'rasant',
      durationMs: 4000,
      pose: (t) => {
        const s = smooth(t);
        return {
          theta: (11 * Math.PI) / 12 + t * (Math.PI / 3),
          phi: lerp(0.9, 1.3, s),
          radius: lerp(close, grazing, s),
          ...target(lerp(panA.x, panB.x, s), lerp(panA.z, panB.z, s)),
        };
      },
    },
  ];
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))]!;
}

function summarize(segment: string, frames: FrameRecord[], refreshMs: number, uploadsBefore: number): ViewerBenchSegmentReport {
  const intervals = frames.map((frame) => frame.intervalMs).filter((ms) => ms > 0);
  const sorted = [...intervals].sort((a, b) => a - b);
  const intervalSum = intervals.reduce((sum, ms) => sum + ms, 0);
  const round = (value: number, digits = 1) => Number(value.toFixed(digits));
  const last = frames[frames.length - 1];
  return {
    segment,
    frames: frames.length,
    fps: intervalSum > 0 ? round((1000 * intervals.length) / intervalSum) : 0,
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    missedRatio: round(intervals.filter((ms) => ms > refreshMs * 1.5).length / Math.max(1, intervals.length), 3),
    drawMs: round(mean(frames.map((frame) => frame.drawMs)), 2),
    shadeMs: round(mean(frames.map((frame) => frame.shadeMs)), 2),
    cpuMs: round(mean(frames.map((frame) => frame.cpuMs)), 2),
    points: Math.round(mean(frames.map((frame) => frame.selectedPoints))),
    budget: last?.pointBudget ?? 0,
    uploads: last ? last.uploadedNodes - uploadsBefore : 0,
  };
}

export class ViewerBench {
  private readonly camera: CameraController;
  private readonly segments: Segment[];
  private readonly getRefreshMs: () => number;
  private readonly onDone: (result: ViewerBenchResult) => void;
  private readonly pathMs: number;
  private startTime = -1;
  private lastFrameTime = -1;
  private running = false;
  /** Images par passe et par segment. */
  private readonly frames: FrameRecord[][][];
  private readonly uploadsAtStart: number[][];

  constructor(options: {
    camera: CameraController;
    extent: number;
    groundAt: (x: number, z: number) => number;
    getRefreshMs: () => number;
    onDone: (result: ViewerBenchResult) => void;
  }) {
    this.camera = options.camera;
    this.segments = buildSegments(options.extent, options.groundAt);
    this.getRefreshMs = options.getRefreshMs;
    this.onDone = options.onDone;
    this.pathMs = this.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    this.frames = PASSES.map(() => this.segments.map(() => []));
    this.uploadsAtStart = PASSES.map(() => this.segments.map(() => -1));
  }

  start(): void {
    this.running = true;
    window.requestAnimationFrame(this.tick);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Appelé par la boucle de rendu après chaque image rendue. */
  recordFrame(now: number, frame: ViewerBenchFrame): void {
    if (!this.running || this.startTime < 0) return;
    const position = this.locate(now);
    const intervalMs = this.lastFrameTime >= 0 ? now - this.lastFrameTime : 0;
    this.lastFrameTime = now;
    if (!position) return;
    const { pass, segment } = position;
    if (this.uploadsAtStart[pass]![segment]! < 0) this.uploadsAtStart[pass]![segment] = frame.uploadedNodes;
    this.frames[pass]![segment]!.push({ ...frame, intervalMs });
  }

  private locate(now: number): { pass: number; segment: number; t: number } | null {
    const elapsed = now - this.startTime;
    const pass = Math.floor(elapsed / this.pathMs);
    if (pass >= PASSES.length) return null;
    let offset = elapsed - pass * this.pathMs;
    for (let segment = 0; segment < this.segments.length; segment++) {
      const duration = this.segments[segment]!.durationMs;
      if (offset < duration) return { pass, segment, t: offset / duration };
      offset -= duration;
    }
    return null;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    if (this.startTime < 0) this.startTime = now;
    const position = this.locate(now);
    if (!position) {
      this.finish();
      return;
    }
    this.camera.setPose(this.segments[position.segment]!.pose(position.t));
    window.requestAnimationFrame(this.tick);
  };

  private finish(): void {
    this.running = false;
    const refreshMs = this.getRefreshMs();
    const passes = PASSES.map((pass, passIndex) => {
      const segments = this.segments.map((segment, segmentIndex) => summarize(
        segment.name,
        this.frames[passIndex]![segmentIndex]!,
        refreshMs,
        Math.max(0, this.uploadsAtStart[passIndex]![segmentIndex]!),
      ));
      const allFrames = this.frames[passIndex]!.flat();
      const total = summarize('total', allFrames, refreshMs, Math.max(0, this.uploadsAtStart[passIndex]![0]!));
      return { pass, segments, total };
    });
    this.onDone({ passes, refreshMs: Number(refreshMs.toFixed(2)) });
  }
}
