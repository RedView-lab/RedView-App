import type { Map as MapboxMap } from 'mapbox-gl';

import { frameTimestamp } from '../lib/frameClock';
import type { MotionStore } from './MotionStore';

/**
 * Curseurs des autres éditeurs sur la carte 3D (comme Figma), et le point
 * qu'ils survolent sur la trace (graphique d'analyse partagé).
 *
 * Calque DOM impératif dans le conteneur de la carte (donc sous les panneaux
 * en verre), sans React : positions reprojetées à chaque image où quelque
 * chose bouge — leur pointeur (rejoué en différé par le MotionStore) ou ma
 * caméra (événement `render` de Mapbox : dans la même image que la carte).
 * Posés sur le relief (`map.project` suit le terrain) ; identiques dans les
 * deux thèmes, comme tout le contenu de la carte.
 */

export interface CursorPeer {
  clientId: string;
  name: string;
  /** Couleur de sa pastille. */
  color: string;
  /** Texte lisible sur cette couleur. */
  ink: string;
}

/** Point de la trace survolé : position sur la carte (null : itinéraire inconnu ou sans tracé). */
export type ChartPointResolver = (itineraryId: string, distanceM: number) => [number, number] | null;

interface CursorNodes {
  peer: CursorPeer;
  cursor: HTMLDivElement;
  label: HTMLSpanElement;
  dot: HTMLDivElement;
  cursorVisible: boolean;
  dotVisible: boolean;
}

/** Marge hors écran avant de cacher (un curseur au bord reste visible). */
const OFFSCREEN_MARGIN_PX = 24;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Flèche de curseur (24 × 24, pointe en 3,2). */
const ARROW_PATH = 'M3.5 2.2 20.2 9.6c.9.4.8 1.7-.1 2l-6.6 2.1-2.4 6.5c-.3.9-1.6.9-2 .1L2.3 3.4c-.4-.8.4-1.6 1.2-1.2Z';

export class PeerCursorsOverlay {
  private readonly map: MapboxMap;
  private readonly store: MotionStore;
  private readonly root: HTMLDivElement;
  private readonly nodes = new Map<string, CursorNodes>();
  private resolveChartPoint: ChartPointResolver = () => null;
  private frameId: number | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(map: MapboxMap, store: MotionStore) {
    this.map = map;
    this.store = store;
    this.root = document.createElement('div');
    this.root.className = 'rv-peer-cursors';
    this.root.setAttribute('aria-hidden', 'true');
  }

  /** Pose le calque dans la carte et suit ses rendus. */
  connect(): void {
    if (this.disposers.length > 0) return;
    const { map, store } = this;
    map.getContainer().appendChild(this.root);
    // Horodatage de l'image (celui du suivi et de la boucle rAF), pas l'instant de fin du rendu.
    const onRender = () => this.update(frameTimestamp());
    map.on('render', onRender);
    this.disposers.push(
      () => map.off('render', onRender),
      store.subscribe((clientId) => {
        if (this.nodes.has(clientId)) this.requestFrame();
      }),
    );
    this.requestFrame();
  }

  /** Éditeurs présents (sans celui-ci) : un curseur chacun. */
  setPeers(peers: readonly CursorPeer[]): void {
    const keep = new Set(peers.map((peer) => peer.clientId));
    for (const [clientId, nodes] of this.nodes) {
      if (keep.has(clientId)) continue;
      nodes.cursor.remove();
      nodes.dot.remove();
      this.nodes.delete(clientId);
    }
    for (const peer of peers) {
      const existing = this.nodes.get(peer.clientId);
      if (existing) {
        if (existing.peer.name !== peer.name) existing.label.textContent = peer.name;
        if (existing.peer.color !== peer.color || existing.peer.ink !== peer.ink) this.paint(existing.cursor, existing.dot, peer);
        existing.peer = peer;
        continue;
      }
      this.nodes.set(peer.clientId, this.create(peer));
    }
    this.requestFrame();
  }

  setChartPointResolver(resolver: ChartPointResolver): void {
    this.resolveChartPoint = resolver;
    this.requestFrame();
  }

  /** Retire le calque (les curseurs restent prêts pour un nouveau `connect`). */
  disconnect(): void {
    if (this.frameId !== null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.root.remove();
  }

  private create(peer: CursorPeer): CursorNodes {
    const cursor = document.createElement('div');
    cursor.className = 'rv-peer-cursor';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rv-peer-cursor__arrow');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ARROW_PATH);
    svg.appendChild(path);
    const label = document.createElement('span');
    label.className = 'rv-peer-cursor__label';
    label.textContent = peer.name;
    cursor.append(svg, label);

    const dot = document.createElement('div');
    dot.className = 'rv-peer-cursor-dot';
    this.paint(cursor, dot, peer);
    this.root.append(dot, cursor);
    return { peer, cursor, label, dot, cursorVisible: false, dotVisible: false };
  }

  private paint(cursor: HTMLElement, dot: HTMLElement, peer: CursorPeer): void {
    for (const element of [cursor, dot]) {
      element.style.setProperty('--rv-peer-color', peer.color);
      element.style.setProperty('--rv-peer-ink', peer.ink);
    }
  }

  private requestFrame(): void {
    if (this.frameId !== null || this.disposers.length === 0) return;
    this.frameId = window.requestAnimationFrame((now) => {
      this.frameId = null;
      if (!this.update(now)) this.requestFrame();
    });
  }

  /** Repositionne tout ; rend `true` quand plus rien ne bouge de leur côté. */
  private update(now: number): boolean {
    if (this.nodes.size === 0) return true;
    const container = this.map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    let settled = true;
    for (const [clientId, nodes] of this.nodes) {
      const frame = this.store.frame(clientId, now);
      if (frame && !((frame.ptr?.settled ?? true) && (frame.chart?.settled ?? true))) settled = false;

      const pointer = frame?.ptr?.values ?? null;
      nodes.cursorVisible = this.place(nodes.cursor, pointer ? [pointer[0], pointer[1]] : null, width, height, nodes.cursorVisible);

      const chart = frame?.chart;
      const chartPoint = chart?.values && chart.key ? this.resolveChartPoint(chart.key, chart.values[0]) : null;
      nodes.dotVisible = this.place(nodes.dot, chartPoint, width, height, nodes.dotVisible);
    }
    return settled;
  }

  private place(element: HTMLElement, lngLat: [number, number] | null, width: number, height: number, wasVisible: boolean): boolean {
    let visible = false;
    if (lngLat) {
      try {
        const point = this.map.project(lngLat);
        visible = Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x > -OFFSCREEN_MARGIN_PX && point.x < width + OFFSCREEN_MARGIN_PX
          && point.y > -OFFSCREEN_MARGIN_PX && point.y < height + OFFSCREEN_MARGIN_PX;
        if (visible) element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
      } catch {
        visible = false;
      }
    }
    if (visible !== wasVisible) element.classList.toggle('is-visible', visible);
    return visible;
  }
}
