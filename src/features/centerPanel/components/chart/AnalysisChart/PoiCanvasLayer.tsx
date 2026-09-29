import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import { shouldRenderPoiCluster } from './poi';
import {
  getChartPoiSprite,
  getChartPoiSpriteKey,
  getChartPoiSpriteKind,
  loadChartPoiSprite,
  POI_HOVER_SCALE,
  type ChartPoiSprite,
  type ChartPoiSpriteKind,
} from './poiSprites';
import type { PoiMarkerGroup, VisiblePoiAnnotation } from './types';

/**
 * Chart POI layer — ONE canvas instead of one filtered `<button>` per POI.
 *
 * Same visuals as the former DOM markers (sprites from `poiSprites.ts`), same
 * stacking (clusters < POIs < favorites < hovered), same interactions: hover
 * lift + pointer cursor + native tooltip, click to open, cluster click to
 * zoom. Hit-testing runs against the former button boxes. Pan / zoom only
 * re-blits cached bitmaps — no React reconciliation of hundreds of nodes and
 * no stacked CSS drop-shadows repainted per frame.
 */

export interface PoiCanvasHandlers {
  onPoiClusterClick: (group: PoiMarkerGroup) => void;
  onPoiClick?: (annotation: VisiblePoiAnnotation) => void;
}

/** Room around the plot area: markers stick out above it (anchored at their base). */
const CANVAS_OVERFLOW_PX = 64;

interface DrawItem {
  key: string;
  kind: ChartPoiSpriteKind;
  xRatio: number;
  yRatio: number;
  z: number;
  title: string;
  annotation: VisiblePoiAnnotation | null;
  group: PoiMarkerGroup | null;
}

interface PoiCanvasLayerProps {
  poiMarkerGroups: PoiMarkerGroup[];
  visibleFraction: number;
  expandedPoiClusterId: string | null;
  handlersRef: RefObject<PoiCanvasHandlers>;
  plotAreaRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
}

function markerTitle(annotation: VisiblePoiAnnotation): string {
  return `${annotation.itineraryName} · ${annotation.categoryLabel} · ${annotation.label}`;
}

export const PoiCanvasLayer = memo(function PoiCanvasLayer({
  poiMarkerGroups,
  visibleFraction,
  expandedPoiClusterId,
  handlersRef,
  plotAreaRef,
  width,
  height,
}: PoiCanvasLayerProps) {
  const { t } = useAppI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [spriteVersion, setSpriteVersion] = useState(0);
  const hoveredKeyRef = useRef<string | null>(null);
  const pressedKeyRef = useRef<string | null>(null);

  // Draw list in paint order (the former CSS z-index stacking, DOM order as tiebreak).
  const items = useMemo<DrawItem[]>(() => {
    const list: DrawItem[] = [];
    for (const group of poiMarkerGroups) {
      if (group.kind === 'single') {
        const annotation = group.members[0];
        list.push({
          key: annotation.id,
          kind: getChartPoiSpriteKind(annotation),
          xRatio: group.xRatio,
          yRatio: group.yRatio,
          z: annotation.favorite ? 40 : 10,
          title: markerTitle(annotation),
          annotation,
          group: null,
        });
        continue;
      }

      if (shouldRenderPoiCluster(group, visibleFraction, expandedPoiClusterId)) {
        list.push({
          key: group.id,
          kind: { type: 'cluster' },
          xRatio: group.xRatio,
          yRatio: group.yRatio,
          z: 0,
          title: t('{{count}} POI regroupés. Cliquer pour zoomer sur cette zone.', { count: group.count }),
          annotation: null,
          group,
        });
        continue;
      }

      // Expanded cluster: non-favorites first (below), favorites last (on top).
      const sortedMembers = [...group.members].sort((a, b) => {
        if (Boolean(a.favorite) === Boolean(b.favorite)) return 0;
        return a.favorite ? 1 : -1;
      });
      sortedMembers.forEach((annotation, index) => {
        list.push({
          key: annotation.id,
          kind: getChartPoiSpriteKind(annotation),
          xRatio: annotation.xRatio,
          yRatio: annotation.yRatio,
          z: (annotation.favorite ? 40 : 10) + index,
          title: markerTitle(annotation),
          annotation,
          group: null,
        });
      });
    }
    // Stable sort keeps DOM order within an equal z-index.
    return list.map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.z - b.item.z || a.index - b.index)
      .map(({ item }) => item);
  }, [expandedPoiClusterId, poiMarkerGroups, t, visibleFraction]);

  // Latest values for the native listeners / draw (synced before paint).
  const itemsRef = useRef(items);
  const sizeRef = useRef({ width, height });
  useLayoutEffect(() => {
    itemsRef.current = items;
    sizeRef.current = { width, height };
  }, [items, width, height]);

  // Request missing sprites; redraw once they are ready.
  useEffect(() => {
    let cancelled = false;
    const pending: Promise<unknown>[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = getChartPoiSpriteKey(item.kind, false);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!getChartPoiSprite(key)) pending.push(loadChartPoiSprite(item.kind, false));
    }
    if (pending.length === 0) return undefined;
    void Promise.all(pending).then(() => {
      if (!cancelled) setSpriteVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width: plotW, height: plotH } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(0, plotW + CANVAS_OVERFLOW_PX * 2);
    const cssH = Math.max(0, plotH + CANVAS_OVERFLOW_PX * 2);
    const pixelW = Math.round(cssW * dpr);
    const pixelH = Math.round(cssH * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelW, pixelH);
    if (plotW <= 0 || plotH <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, CANVAS_OVERFLOW_PX * dpr, CANVAS_OVERFLOW_PX * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const hoveredKey = hoveredKeyRef.current;
    let hoveredItem: DrawItem | null = null;
    for (const item of itemsRef.current) {
      if (item.key === hoveredKey) {
        hoveredItem = item;
        continue;
      }
      const sprite = getChartPoiSprite(getChartPoiSpriteKey(item.kind, false));
      if (!sprite) continue;
      const x = item.xRatio * plotW;
      const y = item.yRatio * plotH;
      ctx.drawImage(sprite.canvas, x - sprite.anchorX, y - sprite.anchorY, sprite.width, sprite.height);
    }

    // Hovered marker on top, scaled 1.15 around its box centre (former :hover CSS).
    if (hoveredItem) {
      const hoverSprite =
        getChartPoiSprite(getChartPoiSpriteKey(hoveredItem.kind, true))
        ?? getChartPoiSprite(getChartPoiSpriteKey(hoveredItem.kind, false));
      if (hoverSprite) {
        const s = POI_HOVER_SCALE;
        const cx = hoveredItem.xRatio * plotW;
        const cy = hoveredItem.yRatio * plotH + hoverSprite.box.top + hoverSprite.box.height / 2;
        const pivotY = hoverSprite.anchorY + hoverSprite.box.top + hoverSprite.box.height / 2;
        ctx.drawImage(
          hoverSprite.canvas,
          cx - s * hoverSprite.anchorX,
          cy - s * pivotY,
          hoverSprite.width * s,
          hoverSprite.height * s,
        );
      }
    }
  }, []);

  useEffect(() => {
    draw();
  }, [draw, items, width, height, spriteVersion]);

  // ── Pointer interactions (native listeners on the plot area) ──────────

  useEffect(() => {
    const plotArea = plotAreaRef.current;
    if (!plotArea) return undefined;

    let frameId: number | null = null;
    let lastClient: { x: number; y: number } | null = null;
    let appliedTitle: string | null = null;

    const spriteFor = (item: DrawItem): ChartPoiSprite | null =>
      getChartPoiSprite(getChartPoiSpriteKey(item.kind, false));

    const hitTest = (clientX: number, clientY: number): DrawItem | null => {
      const rect = plotArea.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { width: plotW, height: plotH } = sizeRef.current;
      const list = itemsRef.current;
      const hoveredKey = hoveredKeyRef.current;

      const contains = (item: DrawItem, scale: number): boolean => {
        const sprite = spriteFor(item);
        if (!sprite) return false;
        const ax = item.xRatio * plotW;
        const ay = item.yRatio * plotH;
        const { left, top, width: bw, height: bh } = sprite.box;
        const cy = ay + top + bh / 2;
        const halfW = (bw * scale) / 2;
        const halfH = (bh * scale) / 2;
        return px >= ax + left + bw / 2 - halfW && px <= ax + left + bw / 2 + halfW
          && py >= cy - halfH && py <= cy + halfH;
      };

      // Topmost first: the hovered marker, then reverse paint order.
      if (hoveredKey) {
        const hovered = list.find((item) => item.key === hoveredKey);
        if (hovered && contains(hovered, POI_HOVER_SCALE)) return hovered;
      }
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index];
        if (item.key !== hoveredKey && contains(item, 1)) return item;
      }
      return null;
    };

    const applyHover = (item: DrawItem | null) => {
      const nextKey = item?.key ?? null;
      if (nextKey !== hoveredKeyRef.current) {
        hoveredKeyRef.current = nextKey;
        if (item && item.kind.type !== 'cluster') void loadChartPoiSprite(item.kind, true).then(() => draw());
        draw();
      }
      const cursor = item ? (item.kind.type === 'cluster' ? 'zoom-in' : 'pointer') : '';
      if (plotArea.style.cursor !== cursor) plotArea.style.cursor = cursor;
      const title = item?.title ?? null;
      if (title !== appliedTitle) {
        appliedTitle = title;
        if (title) plotArea.setAttribute('title', title);
        else plotArea.removeAttribute('title');
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      lastClient = { x: event.clientX, y: event.clientY };
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        if (!lastClient) return;
        applyHover(hitTest(lastClient.x, lastClient.y));
      });
    };

    const handlePointerLeave = () => {
      lastClient = null;
      applyHover(null);
    };

    // Capture phase: a press on a POI must not start the plot's drag-select /
    // click-to-center (the former buttons stopped propagation the same way).
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const hit = hitTest(event.clientX, event.clientY);
      pressedKeyRef.current = hit?.key ?? null;
      if (hit) event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const hit = hitTest(event.clientX, event.clientY);
      const pressedKey = pressedKeyRef.current;
      pressedKeyRef.current = null;
      if (!hit || hit.key !== pressedKey) return;
      event.stopPropagation();
      if (hit.group) handlersRef.current.onPoiClusterClick(hit.group);
      else if (hit.annotation) handlersRef.current.onPoiClick?.(hit.annotation);
    };

    plotArea.addEventListener('pointermove', handlePointerMove, { passive: true });
    plotArea.addEventListener('pointerleave', handlePointerLeave);
    plotArea.addEventListener('pointerdown', handlePointerDown, true);
    plotArea.addEventListener('click', handleClick, true);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      plotArea.removeEventListener('pointermove', handlePointerMove);
      plotArea.removeEventListener('pointerleave', handlePointerLeave);
      plotArea.removeEventListener('pointerdown', handlePointerDown, true);
      plotArea.removeEventListener('click', handleClick, true);
      plotArea.style.cursor = '';
      plotArea.removeAttribute('title');
    };
  }, [draw, handlersRef, plotAreaRef]);

  // Items changed under a still cursor (pan / zoom): drop a stale hover.
  useEffect(() => {
    const hoveredKey = hoveredKeyRef.current;
    if (hoveredKey && !items.some((item) => item.key === hoveredKey)) {
      hoveredKeyRef.current = null;
      draw();
    }
  }, [draw, items]);

  return <canvas ref={canvasRef} className="rvchart__poi-canvas" style={CANVAS_STYLE} aria-hidden="true" />;
});

const CANVAS_STYLE: CSSProperties = {
  left: -CANVAS_OVERFLOW_PX,
  top: -CANVAS_OVERFLOW_PX,
  width: `calc(100% + ${CANVAS_OVERFLOW_PX * 2}px)`,
  height: `calc(100% + ${CANVAS_OVERFLOW_PX * 2}px)`,
};
