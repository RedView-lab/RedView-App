import mapboxgl from 'mapbox-gl';
import type { LngLat, Map as MapboxMap } from 'mapbox-gl';

/**
 * Marqueurs Mapbox des bulles (un par fil, groupe ou brouillon), hors de
 * React : la couche de la carte synchronise la liste voulue, React rend le
 * contenu de chaque bulle dans l'élément de son marqueur (portail), lu par
 * `useSyncExternalStore`.
 *
 * Marqueurs DOM posés sur le relief (Mapbox lit l'altitude du terrain), pointe
 * en bas à gauche ; estompés derrière une crête (`occludedOpacity`) plutôt
 * que masqués : on sait qu'une bulle est là. Une bulle de son auteur se
 * déplace en la glissant.
 */

export interface CommentMarkerEntry {
  key: string;
  lng: number;
  lat: number;
  /** Fil déplacé au glisser (null : pas déplaçable). */
  dragThreadId: string | null;
  /** Au-dessus des autres bulles (survolée, ouverte, brouillon). */
  raised: boolean;
}

interface Registered {
  marker: mapboxgl.Marker;
  element: HTMLDivElement;
  entry: CommentMarkerEntry;
  /** Fin du dernier glisser (le clic qui le suit n'ouvre pas le fil). */
  draggedAt: number;
}

export type CommentMarkerElements = ReadonlyMap<string, HTMLDivElement>;

/** Estompage d'une bulle cachée par le relief. */
const OCCLUDED_OPACITY = 0.35;
/** Un clic juste après un glisser n'ouvre pas le fil. */
const CLICK_AFTER_DRAG_MS = 300;

export class CommentMarkerRegistry {
  private readonly items = new Map<string, Registered>();
  private snapshot: CommentMarkerElements = new Map();
  private readonly listeners = new Set<() => void>();
  private map: MapboxMap | null = null;
  private onDragEnd: (threadId: string, lngLat: LngLat) => void = () => undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CommentMarkerElements => this.snapshot;

  /** Le fil de ce marqueur vient d'être glissé : son clic est ignoré. */
  wasJustDragged(key: string): boolean {
    const item = this.items.get(key);
    return item !== undefined && performance.now() - item.draggedAt < CLICK_AFTER_DRAG_MS;
  }

  sync(
    map: MapboxMap | null,
    entries: readonly CommentMarkerEntry[],
    onDragEnd: (threadId: string, lngLat: LngLat) => void,
  ): void {
    this.onDragEnd = onDragEnd;
    if (map !== this.map) {
      this.clear();
      this.map = map;
    }
    if (!map) return;
    let changed = false;
    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [key, item] of this.items) {
      if (wanted.has(key)) continue;
      item.marker.remove();
      this.items.delete(key);
      changed = true;
    }
    for (const entry of entries) {
      const item = this.items.get(entry.key);
      if (item) {
        const current = item.marker.getLngLat();
        if (current.lng !== entry.lng || current.lat !== entry.lat) item.marker.setLngLat([entry.lng, entry.lat]);
        const draggable = entry.dragThreadId !== null;
        if (item.marker.isDraggable() !== draggable) item.marker.setDraggable(draggable);
        item.element.classList.toggle('is-raised', entry.raised);
        item.entry = entry;
        continue;
      }
      this.items.set(entry.key, this.create(map, entry));
      changed = true;
    }
    if (changed) this.publish();
  }

  clear(): void {
    if (this.items.size === 0) return;
    for (const item of this.items.values()) item.marker.remove();
    this.items.clear();
    this.publish();
  }

  private create(map: MapboxMap, entry: CommentMarkerEntry): Registered {
    const element = document.createElement('div');
    element.className = 'rv-comment-marker';
    element.classList.toggle('is-raised', entry.raised);
    const marker = new mapboxgl.Marker({
      element,
      anchor: 'bottom-left',
      pitchAlignment: 'viewport',
      rotationAlignment: 'viewport',
      occludedOpacity: OCCLUDED_OPACITY,
      draggable: entry.dragThreadId !== null,
    }).setLngLat([entry.lng, entry.lat]);
    const registered: Registered = { marker, element, entry, draggedAt: 0 };
    marker.on('dragstart', () => element.classList.add('is-dragging'));
    marker.on('dragend', () => {
      element.classList.remove('is-dragging');
      registered.draggedAt = performance.now();
      const threadId = registered.entry.dragThreadId;
      if (threadId) this.onDragEnd(threadId, marker.getLngLat());
    });
    marker.addTo(map);
    return registered;
  }

  private publish(): void {
    this.snapshot = new Map([...this.items].map(([key, item]) => [key, item.element]));
    for (const listener of [...this.listeners]) listener();
  }
}
