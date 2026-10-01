/**
 * Fenêtrage (virtualisation) des lignes de la feuille de route.
 *
 * Une recherche POI sur un long itinéraire insère 800+ lignes : toutes dans
 * le DOM, chaque rendu du panneau (sauvegarde auto, changement de projet…)
 * les réconciliait et le navigateur recalculait style / layout pour ~20 000
 * nœuds. Seules les lignes visibles (+ une marge) sont maintenant montées ;
 * deux espaceurs gardent la hauteur exacte de la liste, donc la barre de
 * défilement et la position restent identiques.
 *
 * - Hauteurs réelles mesurées par ResizeObserver (estimation avant mesure).
 * - Le viewport est quantifié : un rendu tous les ~3 lignes défilées, pas à
 *   chaque frame de scroll.
 * - Une ligne remontée par le défilement n'est pas ré-animée : seules les
 *   lignes réellement nouvelles jouent l'animation d'apparition.
 * - `requestTimelineRowReveal(id)` amène une ligne hors fenêtre dans le DOM
 *   (sélection d'un POI sur la carte → centrage dans la liste).
 * - Sous `minCount` lignes, tout est rendu : aucun changement pour les
 *   petits itinéraires.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const REVEAL_EVENT = 'rvi:timeline-reveal-row';
/** Pas de quantification du viewport (px) : < marge, donc jamais de trou. */
const VIEWPORT_STEP_PX = 96;
/** Lignes rendues avant la première mesure du viewport. */
const INITIAL_ROW_COUNT = 40;

/** Demande à la liste fenêtrée qui contient `id` de la monter (défilement instantané). */
export function requestTimelineRowReveal(id: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(REVEAL_EVENT, { detail: { id } }));
}

interface VirtualRowsOptions {
  /** Clés des lignes, dans l'ordre affiché. */
  keys: readonly string[];
  /** Hauteur d'une ligne avant mesure (px). */
  estimateRowPx: number;
  /** Écart vertical entre deux lignes (gap flex / row-gap grid, px). */
  gapPx: number;
  overscanPx?: number;
  minCount?: number;
}

export interface VirtualRows {
  /** Parent direct des lignes (chaque ligne porte `data-vrow={key}`). */
  attachRowsRoot: (element: HTMLElement | null) => void;
  /** Élément juste au-dessus de la première ligne (en-tête de la liste). */
  attachHeader: (element: HTMLElement | null) => void;
  start: number;
  end: number;
  /** Hauteurs des espaceurs haut / bas (0 = pas d'espaceur). */
  topSpacerPx: number;
  bottomSpacerPx: number;
}

interface Viewport {
  /** Haut de la zone visible, en coordonnées liste (ligne 0 = 0), quantifié. */
  top: number;
  height: number;
}

interface MountState {
  root: HTMLElement | null;
  /** Clés présentes lors d'un rendu précédent (animation d'apparition). */
  seenKeys: Set<string>;
  /** Éléments de ligne déjà traités depuis leur montage. */
  mountedRows: WeakSet<Element>;
  /** Éléments mesurés (désobservés une fois démontés). */
  observed: Set<Element>;
  observer: ResizeObserver | null;
}

/**
 * Hauteurs mesurées. La table est mutée par l'observateur ; l'enveloppe n'est
 * remplacée (→ nouveau rendu) que si une mesure contredit la hauteur supposée
 * jusque-là, pas à chaque ligne qui entre dans la fenêtre.
 */
interface HeightSnapshot {
  map: Map<string, number>;
}

function averageHeight(map: ReadonlyMap<string, number>, estimate: number): number {
  if (map.size === 0) return estimate;
  let sum = 0;
  for (const height of map.values()) sum += height;
  return sum / map.size;
}

function createMountState(
  heights: Map<string, number>,
  estimateRowPx: number,
  invalidate: () => void,
): MountState {
  const observer = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) => {
      const fallback = averageHeight(heights, estimateRowPx);
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const row = target.hasAttribute('data-vrow') ? target : target.parentElement;
        const key = row?.getAttribute('data-vrow');
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? target.getBoundingClientRect().height;
        if (!(height > 0)) continue;
        if (Math.abs((heights.get(key) ?? fallback) - height) >= 0.5) changed = true;
        heights.set(key, height);
      }
      if (changed) invalidate();
    });
  return {
    root: null,
    seenKeys: new Set(),
    mountedRows: new WeakSet(),
    observed: new Set(),
    observer,
  };
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  // Le corps du panneau timeline est le conteneur qui défile ; la grille
  // (overflow-x: auto ⇒ overflow-y calculé à auto) ne doit pas être prise.
  const timelineBody = element.closest<HTMLElement>('.rvi-timeline__body');
  if (timelineBody) return timelineBody;
  let node = element.parentElement;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/** Élément qui porte la hauteur de la ligne (une ligne de grille est en `display: contents`). */
function measuredElementOf(row: HTMLElement): HTMLElement | null {
  if (window.getComputedStyle(row).display !== 'contents') return row;
  return row.firstElementChild instanceof HTMLElement ? row.firstElementChild : null;
}

/** Premier index i tel que `offsets[i] > value` (offsets croissants). */
function upperBound(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function useVirtualRows({
  keys,
  estimateRowPx,
  gapPx,
  overscanPx = 640,
  minCount = 80,
}: VirtualRowsOptions): VirtualRows {
  const [rowsRoot, setRowsRoot] = useState<HTMLElement | null>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [heights, setHeights] = useState<HeightSnapshot>(() => ({ map: new Map() }));
  // Lu / écrit uniquement dans les effets.
  const mountStateRef = useRef<MountState | null>(null);

  const enabled = keys.length >= minCount;

  // offsets[i] = début de la ligne i (gap inclus) ; offsets[n] = hauteur totale + gap.
  // Ligne jamais montée : hauteur moyenne des lignes mesurées (la hauteur
  // totale, donc la barre de défilement, converge dès les premières mesures).
  const offsets = useMemo(() => {
    const fallback = averageHeight(heights.map, estimateRowPx);
    const result = new Float64Array(keys.length + 1);
    for (let i = 0; i < keys.length; i += 1) {
      result[i + 1] = result[i]! + (heights.map.get(keys[i]!) ?? fallback) + gapPx;
    }
    return result;
  }, [estimateRowPx, gapPx, heights, keys]);

  const count = keys.length;
  let start = 0;
  let end = count;
  if (enabled) {
    if (viewport) {
      const from = viewport.top - overscanPx;
      const to = viewport.top + viewport.height + VIEWPORT_STEP_PX + overscanPx;
      start = Math.min(count, Math.max(0, upperBound(offsets, from) - 1));
      end = Math.min(count, Math.max(start, upperBound(offsets, to)));
    } else {
      end = Math.min(count, INITIAL_ROW_COUNT);
    }
  }
  const topSpacerPx = start > 0 ? offsets[start]! - gapPx : 0;
  const bottomSpacerPx = end < count ? offsets[count]! - offsets[end]! - gapPx : 0;

  const scroller = useMemo(() => (rowsRoot ? findScrollParent(rowsRoot) : null), [rowsRoot]);

  const measureViewport = useCallback(() => {
    if (!scroller || !header) return;
    const firstRowTop = header.getBoundingClientRect().bottom + gapPx;
    const rawTop = scroller.getBoundingClientRect().top - firstRowTop;
    const top = Math.floor(rawTop / VIEWPORT_STEP_PX) * VIEWPORT_STEP_PX;
    const height = scroller.clientHeight;
    setViewport((prev) => (prev && prev.top === top && prev.height === height ? prev : { top, height }));
  }, [gapPx, header, scroller]);

  // Viewport : défilement (1 lecture par frame au plus) et redimensionnement.
  useEffect(() => {
    if (!enabled || !scroller || !header || !rowsRoot) return;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measureViewport();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    // Rappel initial à l'observation : première mesure du viewport.
    const resizeObserver = new ResizeObserver(() => measureViewport());
    resizeObserver.observe(scroller);
    resizeObserver.observe(rowsRoot);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [enabled, header, measureViewport, rowsRoot, scroller]);

  useEffect(() => () => {
    mountStateRef.current?.observer?.disconnect();
    mountStateRef.current = null;
  }, []);

  // Avant peinture, à chaque changement des lignes montées : mesure les
  // nouvelles, et coupe l'animation de celles qui reviennent par le défilement.
  useLayoutEffect(() => {
    if (!rowsRoot) return;
    const state = (mountStateRef.current ??= createMountState(
      heights.map,
      estimateRowPx,
      () => setHeights((prev) => ({ map: prev.map })),
    ));
    if (state.root !== rowsRoot) {
      // Autre disposition (liste ↔ grille) : comme avant, tout s'anime.
      state.root = rowsRoot;
      state.seenKeys.clear();
    }
    for (const element of state.observed) {
      if (element.isConnected) continue;
      state.observer?.unobserve(element);
      state.observed.delete(element);
    }
    // Petite liste (non fenêtrée) : aucune ligne n'est remontée par le
    // défilement, rien à mesurer ni à toucher — comportement d'origine.
    if (enabled) {
      rowsRoot.querySelectorAll<HTMLElement>(':scope > [data-vrow]').forEach((row) => {
        if (state.mountedRows.has(row)) return;
        state.mountedRows.add(row);
        if (state.seenKeys.has(row.getAttribute('data-vrow') ?? '')) row.style.animation = 'none';
        const measured = measuredElementOf(row);
        if (measured && state.observer) {
          state.observer.observe(measured);
          state.observed.add(measured);
        }
      });
    }
    for (const key of keys) state.seenKeys.add(key);
  }, [enabled, estimateRowPx, heights.map, keys, rowsRoot, start, end]);

  // Centrage d'une ligne hors fenêtre : on la fait défiler au centre (instantané),
  // le défilement monte la ligne, puis l'appelant la retrouve dans le DOM.
  useEffect(() => {
    if (!enabled || !scroller || !header) return;
    const onReveal = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      const index = id ? keys.indexOf(id) : -1;
      if (index < 0) return;
      const firstRowTop = header.getBoundingClientRect().bottom + gapPx;
      const rowTopInScroller = firstRowTop - scroller.getBoundingClientRect().top + offsets[index]!;
      const rowHeight = offsets[index + 1]! - offsets[index]! - gapPx;
      scroller.scrollTop += rowTopInScroller - scroller.clientHeight / 2 + rowHeight / 2;
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [enabled, gapPx, header, keys, offsets, scroller]);

  return {
    attachRowsRoot: setRowsRoot,
    attachHeader: setHeader,
    start,
    end,
    topSpacerPx,
    bottomSpacerPx,
  };
}
