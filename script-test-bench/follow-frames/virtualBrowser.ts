/**
 * Navigateur virtuel pour rejouer la présence en direct image par image, sans
 * navigateur : temps simulé, un fil principal par onglet (tâches, minuteries,
 * images rAF calées sur la synchro verticale, rendus Mapbox qui coûtent du
 * temps, longues tâches façon rendu React), cartes Mapbox factices qui
 * reproduisent ce que le vrai code utilise (file de rendu `_requestRenderFrame`,
 * `triggerRepaint`, événements caméra, projection) et un DOM minimal.
 *
 * Le vrai code (PresenceBroadcaster, MotionStore, FollowController,
 * PeerCursorsOverlay) tourne dessus tel quel : `setTimeout`, `performance.now`,
 * `requestAnimationFrame`, `document.timeline.currentTime` sont ceux de
 * l'onglet dont la tâche s'exécute.
 */

export type Rand = () => number;

export function random(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimEvent {
  at: number;
  seq: number;
  tab: Tab;
  run: () => void;
  cancelled: boolean;
}

export interface TabOptions {
  name: string;
  /** Période de synchro verticale (ms) : 16,67 à 60 Hz, 6,94 à 144 Hz. */
  vsyncMs: number;
  vsyncPhase?: number;
  /** Longue tâche (rendu React, GC…) toutes les `longTaskEveryMs` en moyenne. */
  longTaskEveryMs?: number;
  longTaskMs?: [number, number];
  /** Retard d'ordonnancement d'une minuterie au-delà de son échéance (fil principal pris par d'autres petites tâches). */
  timerSlopMs?: [number, number];
  seed: number;
}

export class Tab {
  readonly name: string;
  readonly options: TabOptions;
  readonly rand: Rand;
  now = 0;
  busyUntil = 0;
  /** Horodatage de la dernière image (document.timeline.currentTime). */
  frameTime: number | null = null;
  rafCallbacks: Array<{ id: number; callback: (time: number) => void }> = [];
  /** Appelé à la fin de chaque image (après tous les rappels rAF). */
  onFrameEnd: ((time: number) => void) | null = null;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(options: TabOptions) {
    this.name = options.name;
    this.options = options;
    this.rand = random(options.seed);
  }
}

export class Sim {
  current: Tab | null = null;
  private readonly heap: SimEvent[] = [];
  private seq = 0;
  private nextId = 1;
  private readonly timers = new Map<number, SimEvent>();
  private readonly rafOwners = new Map<number, Tab>();

  schedule(tab: Tab, at: number, run: () => void): SimEvent {
    const event: SimEvent = { at, seq: this.seq += 1, tab, run, cancelled: false };
    this.push(event);
    return event;
  }

  /** Tâche de l'onglet courant qui occupe le fil principal `ms` de plus. */
  advance(ms: number): void {
    const tab = this.requireTab();
    tab.now += ms;
  }

  setTimeout(callback: () => void, ms = 0): number {
    const tab = this.requireTab();
    const [slopMin, slopMax] = tab.options.timerSlopMs ?? [0, 0];
    const due = tab.now + Math.max(1, ms) + slopMin + tab.rand() * (slopMax - slopMin);
    const id = this.nextId;
    this.nextId += 1;
    const event = this.schedule(tab, due, () => {
      this.timers.delete(id);
      callback();
    });
    this.timers.set(id, event);
    return id;
  }

  clearTimeout(id: unknown): void {
    if (typeof id !== 'number') return;
    const event = this.timers.get(id);
    if (event) event.cancelled = true;
    this.timers.delete(id);
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    const tab = this.requireTab();
    const id = this.nextId;
    this.nextId += 1;
    tab.rafCallbacks.push({ id, callback });
    this.rafOwners.set(id, tab);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    const tab = this.rafOwners.get(id);
    if (!tab) return;
    tab.rafCallbacks = tab.rafCallbacks.filter((entry) => entry.id !== id);
    this.rafOwners.delete(id);
  }

  /** Démarre la synchro verticale et les longues tâches de l'onglet. */
  startTab(tab: Tab, from = 0): void {
    const { vsyncMs, vsyncPhase = 0 } = tab.options;
    let k = Math.ceil((from - vsyncPhase) / vsyncMs);
    /** Numéro de la dernière synchro ayant donné une image. */
    let lastFrameIndex = Number.NEGATIVE_INFINITY;
    const tick = () => {
      const index = k;
      k += 1;
      this.schedule(tab, vsyncPhase + k * vsyncMs, tick);
      if (tab.rafCallbacks.length === 0) return;
      // Image en retard (fil principal pris) : horodatage = dernière synchro passée.
      const lateBy = Math.max(0, tab.now - (vsyncPhase + index * vsyncMs));
      const frameIndex = index + Math.floor(lateBy / vsyncMs + 1e-9);
      // Une seule image par synchro (des synchros manquées pendant une longue tâche ne s'accumulent pas).
      if (frameIndex <= lastFrameIndex) return;
      lastFrameIndex = frameIndex;
      const time = vsyncPhase + frameIndex * vsyncMs;
      tab.frameTime = time;
      const callbacks = tab.rafCallbacks;
      tab.rafCallbacks = [];
      for (const { id, callback } of callbacks) {
        this.rafOwners.delete(id);
        callback(time);
      }
      tab.onFrameEnd?.(time);
    };
    this.schedule(tab, vsyncPhase + k * vsyncMs, tick);
    const every = tab.options.longTaskEveryMs;
    if (every) {
      const [minMs, maxMs] = tab.options.longTaskMs ?? [20, 35];
      const longTask = () => {
        this.advance(minMs + tab.rand() * (maxMs - minMs));
        this.schedule(tab, tab.now + every * (0.5 + tab.rand()), longTask);
      };
      this.schedule(tab, from + every * tab.rand(), longTask);
    }
  }

  /** Exécute `run` comme une tâche de `tab` tout de suite (mise en place). */
  within<T>(tab: Tab, run: () => T): T {
    const previous = this.current;
    this.current = tab;
    try {
      return run();
    } finally {
      this.current = previous;
    }
  }

  runUntil(time: number): void {
    while (this.heap.length > 0 && this.heap[0].at <= time) {
      const event = this.pop()!;
      if (event.cancelled) continue;
      const { tab } = event;
      const start = Math.max(event.at, tab.busyUntil);
      if (start > event.at + 1e-9) {
        // Fil principal pris : la tâche attend son tour (ordre global gardé).
        event.at = start;
        this.push(event);
        continue;
      }
      tab.now = Math.max(tab.now, start);
      this.current = tab;
      try {
        event.run();
      } finally {
        this.current = null;
      }
      tab.busyUntil = tab.now;
    }
  }

  private requireTab(): Tab {
    if (!this.current) throw new Error('Sim: aucun onglet courant');
    return this.current;
  }

  private push(event: SimEvent): void {
    const heap = this.heap;
    heap.push(event);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (before(heap[parent], heap[index])) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  }

  private pop(): SimEvent | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

function before(a: SimEvent, b: SimEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

// ── Globales du navigateur ──────────────────────────────────────────────────

export interface FakeElement {
  className: string;
  textContent: string;
  style: { transform: string; setProperty(name: string, value: string): void };
  classList: { toggle(name: string, on?: boolean): void; contains(name: string): boolean };
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): void;
  append(...children: unknown[]): void;
  remove(): void;
  addEventListener(type: string, listener: unknown, options?: unknown): void;
  removeEventListener(type: string, listener: unknown, options?: unknown): void;
}

export function fakeElement(created?: FakeElement[]): FakeElement {
  const classes = new Set<string>();
  const element: FakeElement = {
    className: '',
    textContent: '',
    style: { transform: '', setProperty() {} },
    classList: {
      toggle(name, on) {
        const next = on ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute() {},
    appendChild() {},
    append() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
  };
  created?.push(element);
  return element;
}

/** Installe les globales (minuteries, horloge, rAF, document, window) branchées sur `sim`. */
export function installGlobals(sim: Sim, createdElements: FakeElement[]): () => void {
  const saved = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    performance: Object.getOwnPropertyDescriptor(globalThis, 'performance'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  const tabListeners = (type: string) => {
    const tab = sim.current;
    if (!tab) return null;
    let set = tab.listeners.get(type);
    if (!set) {
      set = new Set();
      tab.listeners.set(type, set);
    }
    return set;
  };
  const eventTarget = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      tabListeners(type)?.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      tabListeners(type)?.delete(listener);
    },
  };
  (globalThis as Record<string, unknown>).setTimeout = (callback: () => void, ms?: number) => sim.setTimeout(callback, ms);
  (globalThis as Record<string, unknown>).clearTimeout = (id: unknown) => sim.clearTimeout(id);
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => sim.current?.now ?? 0 },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      ...eventTarget,
      requestAnimationFrame: (callback: (time: number) => void) => sim.requestAnimationFrame(callback),
      cancelAnimationFrame: (id: number) => sim.cancelAnimationFrame(id),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: {
      ...eventTarget,
      visibilityState: 'visible',
      timeline: {
        get currentTime() {
          return sim.current?.frameTime ?? null;
        },
      },
      createElement: () => fakeElement(createdElements),
      createElementNS: () => fakeElement(),
    },
    configurable: true,
    writable: true,
  });
  return () => {
    (globalThis as Record<string, unknown>).setTimeout = saved.setTimeout;
    (globalThis as Record<string, unknown>).clearTimeout = saved.clearTimeout;
    for (const key of ['performance', 'window', 'document'] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
}

// ── Carte Mapbox factice ────────────────────────────────────────────────────

export interface CameraValues {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

const TILE = 512;

function worldOf(lng: number, lat: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function lngLatOf(x: number, y: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

export interface FakeMapOptions {
  sim: Sim;
  tab: Tab;
  width: number;
  height: number;
  camera: CameraValues;
  /** Coût d'un rendu (ms de fil principal). */
  renderCostMs: () => number;
}

type Listener = (event: Record<string, unknown>) => void;

/**
 * Ce que le code de présence utilise de `mapboxgl.Map` : caméra, projection
 * plane (cap compris, inclinaison ignorée : même formule des deux côtés),
 * événements, rendu à la demande (`triggerRepaint` → une image rAF →
 * `_render(horodatage rAF)` : file `_requestRenderFrame`, coût du rendu, puis
 * l'événement `render`).
 */
export class FakeMap {
  readonly sim: Sim;
  readonly tab: Tab;
  readonly transform = {
    fov: 36.87,
    isPointAboveHorizon: () => false,
  };
  private camera: CameraValues;
  private padding = { top: 0, right: 0, bottom: 0, left: 0 };
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly container: FakeElement & { clientWidth: number; clientHeight: number };
  private readonly canvasContainer = fakeElement();
  private renderQueue: Array<{ id: number; callback: (time: number) => void }> = [];
  private nextTaskId = 1;
  private frame: number | null = null;
  private readonly renderCostMs: () => number;
  /** Rendus effectués : [horodatage, caméra]. */
  readonly rendered: Array<{ time: number; camera: CameraValues }> = [];
  /** Appelé au début de chaque rendu (pilote de la caméra de l'émetteur). */
  beforeRender: ((time: number) => void) | null = null;

  constructor(options: FakeMapOptions) {
    this.sim = options.sim;
    this.tab = options.tab;
    this.camera = { ...options.camera };
    this.renderCostMs = options.renderCostMs;
    this.container = Object.assign(fakeElement(), { clientWidth: options.width, clientHeight: options.height });
  }

  on(type: string, listener: Listener): this {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return this;
  }

  off(type: string, listener: Listener): this {
    this.listeners.get(type)?.delete(listener);
    return this;
  }

  fire(event: string | Record<string, unknown>, data?: Record<string, unknown>): this {
    const payload = typeof event === 'string' ? { type: event, ...data, target: this } : { ...event, target: this };
    for (const listener of [...(this.listeners.get(payload.type as string) ?? [])]) listener(payload);
    return this;
  }

  getCenter() {
    return { lng: this.camera.lng, lat: this.camera.lat };
  }

  getZoom() {
    return this.camera.zoom;
  }

  getBearing() {
    return this.camera.bearing;
  }

  getPitch() {
    return this.camera.pitch;
  }

  getPadding() {
    return { ...this.padding };
  }

  getMinZoom() {
    return 0;
  }

  getMaxZoom() {
    return 22;
  }

  getContainer() {
    return this.container;
  }

  getCanvasContainer() {
    return this.canvasContainer;
  }

  getCamera(): CameraValues {
    return { ...this.camera };
  }

  project(lngLat: readonly [number, number] | { lng: number; lat: number }) {
    const [lng, lat] = Array.isArray(lngLat) ? lngLat : [(lngLat as { lng: number }).lng, (lngLat as { lat: number }).lat];
    const [cx, cy] = worldOf(this.camera.lng, this.camera.lat, this.camera.zoom);
    const [x, y] = worldOf(lng, lat, this.camera.zoom);
    const angle = (-this.camera.bearing * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    return {
      x: this.container.clientWidth / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: this.container.clientHeight / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
  }

  unproject(point: readonly [number, number] | { x: number; y: number }) {
    const [px, py] = Array.isArray(point) ? point : [(point as { x: number }).x, (point as { y: number }).y];
    const [cx, cy] = worldOf(this.camera.lng, this.camera.lat, this.camera.zoom);
    const angle = (this.camera.bearing * Math.PI) / 180;
    const dx = px - this.container.clientWidth / 2;
    const dy = py - this.container.clientHeight / 2;
    const [lng, lat] = lngLatOf(cx + dx * Math.cos(angle) - dy * Math.sin(angle), cy + dx * Math.sin(angle) + dy * Math.cos(angle), this.camera.zoom);
    return { lng, lat };
  }

  /** Caméra posée par l'application (pas d'animation) : événements comme Mapbox, puis une image. */
  jumpTo(options: Partial<{ center: [number, number]; zoom: number; bearing: number; pitch: number; padding: typeof this.padding }>, eventData: Record<string, unknown> = {}): this {
    if (options.center) {
      this.camera.lng = options.center[0];
      this.camera.lat = options.center[1];
    }
    if (options.zoom !== undefined) this.camera.zoom = options.zoom;
    if (options.bearing !== undefined) this.camera.bearing = options.bearing;
    if (options.pitch !== undefined) this.camera.pitch = options.pitch;
    if (options.padding) this.padding = { ...options.padding };
    this.fire({ type: 'movestart', ...eventData });
    this.fire({ type: 'move', ...eventData });
    this.fire({ type: 'moveend', ...eventData });
    this.triggerRepaint();
    return this;
  }

  /** Caméra de l'émetteur (geste ou animation pendant son rendu) : `move` comme Mapbox. */
  setCameraDuringRender(camera: CameraValues, eventData: Record<string, unknown> = {}): void {
    this.camera = { ...camera };
    this.fire({ type: 'move', ...eventData });
  }

  flyTo(options: Parameters<FakeMap['jumpTo']>[0], eventData: Record<string, unknown> = {}): this {
    // Pas de vol dans ce banc : le suivi démarre près de la vue suivie.
    return this.jumpTo(options, eventData);
  }

  stop(): this {
    return this;
  }

  triggerRepaint(): void {
    if (this.frame !== null) return;
    this.frame = this.sim.requestAnimationFrame((time) => {
      this.frame = null;
      this.render(time);
    });
  }

  _requestRenderFrame(callback: (time: number) => void): number {
    const id = this.nextTaskId;
    this.nextTaskId += 1;
    this.renderQueue.push({ id, callback });
    this.triggerRepaint();
    return id;
  }

  _cancelRenderFrame(id: number): void {
    this.renderQueue = this.renderQueue.filter((task) => task.id !== id);
  }

  private render(time: number): void {
    this.beforeRender?.(time);
    // Comme TaskQueue.run : seulement les tâches d'avant le début du rendu.
    const tasks = this.renderQueue;
    this.renderQueue = [];
    for (const task of tasks) task.callback(time);
    this.sim.advance(this.renderCostMs());
    this.rendered.push({ time, camera: { ...this.camera } });
    this.fire('render');
  }
}
