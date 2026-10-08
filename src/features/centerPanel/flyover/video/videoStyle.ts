import type { LayerSpecification, Map as MapboxMap, SourceSpecification, StyleSpecification } from 'mapbox-gl';
import { transformMapboxRequest } from '@/features/map3d';
import { ANALYSIS_HOVER_SOURCE_ID, ROUTE_HOVER_PREVIEW_SOURCE_ID } from '@/features/itineraryPanel/lib/route-layer';
import { POI_GPU_SOURCE_ID } from '@/features/poi/lib/poi-markers';

type StyleSpec = StyleSpecification;
type LayerSpec = LayerSpecification;
export type SourceSpec = SourceSpecification;

/** Sources custom de la carte vivante à recréer sur la carte vidéo (`cloneForMap`). */
export interface CustomSourceClone {
  id: string;
  create: () => unknown;
  layers: Array<{ layer: LayerSpec; beforeId: string | undefined }>;
}

export interface ClonedStyle {
  style: StyleSpec;
  customSources: CustomSourceClone[];
  /** Calques de ligne surélevés : leur décalage d'origine, pour suivre plat ↔ relief. */
  elevatedLineLayers: Map<string, number>;
}

/** Sources de la carte vivante sans place dans la vidéo : POI masqués, survols. */
const DROPPED_SOURCE_IDS = new Set([POI_GPU_SOURCE_ID, ANALYSIS_HOVER_SOURCE_ID, ROUTE_HOVER_PREVIEW_SOURCE_ID]);

function cloneJson<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Style de la carte vivante, tel qu'à l'instant de l'export, pour une carte
 * qui tourne image par image : sources custom recréées à part, POI et survols
 * retirés, fondus de tuiles et transitions de style à zéro (une image n'est
 * prise qu'une fois tout chargé), tuiles du relief hors de l'arbitrage du
 * Service Worker (`rv-src=map` : la carte vivante y annonce les seules tuiles
 * qu'elle attend, celles de la vidéo seraient abandonnées).
 */
export function cloneLiveStyle(liveMap: MapboxMap): ClonedStyle {
  const live = liveMap.getStyle() as StyleSpec;
  const customSources = new Map<string, CustomSourceClone>();
  const dropped = new Set<string>();
  const sources: Record<string, SourceSpec> = {};
  for (const [id, raw] of Object.entries(live.sources ?? {})) {
    const source = raw as SourceSpec;
    if (DROPPED_SOURCE_IDS.has(id)) {
      dropped.add(id);
      continue;
    }
    // Source JS (`addSource` d'un objet) : sérialisée telle quelle, sans ses méthodes.
    if ((source as { type: string }).type === 'custom') {
      dropped.add(id);
      const implementation = (liveMap.getSource(id) as unknown as { _implementation?: { cloneForMap?: () => unknown } } | undefined)
        ?._implementation;
      if (typeof implementation?.cloneForMap === 'function') {
        customSources.set(id, { id, create: () => implementation.cloneForMap?.(), layers: [] });
      }
      continue;
    }
    if (source.type === 'geojson') {
      // Les données GeoJSON sont celles de la carte vivante (même objet) : la carte vidéo n'en écrit aucune.
      sources[id] = source;
      continue;
    }
    const copy = cloneJson(source) as SourceSpec & { tiles?: string[] };
    if (copy.type === 'raster-dem' && Array.isArray(copy.tiles)) {
      copy.tiles = copy.tiles.map((url) => url.replace('rv-src=map', 'rv-src=video'));
    }
    sources[id] = copy;
  }

  const layers: LayerSpec[] = [];
  const elevatedLineLayers = new Map<string, number>();
  const liveLayers = (live.layers ?? []) as LayerSpec[];
  liveLayers.forEach((original, index) => {
    const sourceId = (original as { source?: unknown }).source;
    if (typeof sourceId === 'string' && dropped.has(sourceId)) {
      const custom = customSources.get(sourceId);
      if (custom) {
        const next = liveLayers.slice(index + 1).find((candidate) => {
          const candidateSource = (candidate as { source?: unknown }).source;
          return !(typeof candidateSource === 'string' && dropped.has(candidateSource));
        });
        custom.layers.push({ layer: cloneJson(original), beforeId: next?.id });
      }
      return;
    }
    const layer = cloneJson(original) as LayerSpec & {
      paint?: Record<string, unknown>;
      layout?: Record<string, unknown>;
    };
    if (layer.type === 'raster') layer.paint = { ...(layer.paint ?? {}), 'raster-fade-duration': 0 };
    if (layer.type === 'line' && layer.layout && 'line-elevation-reference' in layer.layout) {
      const offset = Number(layer.layout['line-z-offset']);
      elevatedLineLayers.set(layer.id, Number.isFinite(offset) && offset > 0 ? offset : 0);
    }
    layers.push(layer);
  });

  const style: StyleSpec = {
    ...live,
    sources,
    layers,
    transition: { duration: 0, delay: 0 },
  };
  return { style, customSources: [...customSources.values()], elevatedLineLayers };
}

/** `@2x` pour le sprite : chargé hors rendu, il suivrait le ratio de l'écran et non celui de la vidéo. */
export function videoTransformRequest(pixelRatio: number) {
  return (url: string, resourceType?: string) => {
    if (pixelRatio >= 2 && (resourceType === 'SpriteImage' || resourceType === 'SpriteJSON')) {
      return { url: url.replace(/\/sprite(?!@2x)(?=(\.png|\.json)?(\?|$))(\.png|\.json)?/, '/sprite@2x$3') };
    }
    return transformMapboxRequest(url, resourceType);
  };
}
