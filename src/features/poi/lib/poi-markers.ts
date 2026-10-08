// Marqueurs 3D des POI — pipeline par couche `symbol` GPU.
//
// Chaque POI était autrefois un `mapboxgl.Marker` DOM. Avec les recherches
// exhaustives en corridor (800+ POI sur un parcours type GR20), cela faisait
// des milliers de nœuds DOM, ~3 200 écouteurs sur la carte, une projection sur
// le terrain + un lancer de rayon d'occlusion par marqueur à chaque image de
// caméra, et 800 drop-shadows CSS repeintes par image.
//
// Ils sont maintenant dessinés par UNE couche symbol Mapbox alimentée par UNE
// source GeoJSON :
//
// - Les sprites sont composés une fois par variante visuelle (catégorie ×
//   favori × pause) par `poi-sprites.ts` — mêmes SVG, mêmes badges, ombres
//   intégrées — et enregistrés avec `addImage` à une densité HiDPI.
// - Les défaillances historiques de l'ancienne couche symbol sont neutralisées
//   explicitement : `icon-allow-overlap` + `icon-ignore-placement` (le
//   placement n'écarte jamais un POI), `icon-occlusion-opacity` (occlusion par
//   le relief gérée par le test de profondeur GPU, même résultat que l'ancien
//   `occludedOpacity: 0`), alignement inclinaison / rotation sur la vue.
// - Les rechargements de style sont gérés en réinstallant source / images /
//   couches sur `styledata` (garde `getLayer` peu coûteuse).
// - Le survol utilise `feature-state` + une couche de surbrillance d'un seul
//   objet ; une seule `Popup` partagée remplace les 800 instances par marqueur.
// - Le test de clic est au pixel près (`poi-hit-mask.ts`), jamais celui de
//   Mapbox : il teste un symbole sur toute son image, marge comprise, et
//   renvoie les symboles qui se chevauchent dans l'ordre des données plutôt
//   que dans l'ordre de dessin.
//
// Le coût par image ne dépend donc pas du nombre de POI.

import mapboxgl from 'mapbox-gl';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapboxMap,
  MapMouseEvent,
} from 'mapbox-gl';
import { flyToPoi } from '@/features/map3d/lib/cameraFlight';
import { MAP_CURSOR_PRIORITY, setMapCursor } from '@/features/map3d/lib/mapCursor';
import { keepPopupInVisibleMap } from '@/features/map3d/lib/mapPopupSafeArea';
import { isEventFromDomMarker } from '@/features/map3d/lib/pointPanelDismiss';
import { buildPopupClearanceOffset } from '@/features/map3d/lib/popupOffset';

import type { PoiFeature } from '../types';
import { POI_LABELS } from '../types';
import {
  buildPopupContent,
  resolvePopupState,
  type PoiPopupState,
  type UsePoiPopupActions,
} from './poi-popup';
import { pickPoiHit, type PoiHitCandidate } from './poi-hit-mask';
import {
  getPoiSpriteId,
  getPoiSpritePixelRatio,
  getPoiSpriteSpec,
  rasterizePoiSprite,
  type PoiSprite,
  type PoiSpriteSpec,
} from './poi-sprites';

// ── Réglages visuels ──────────────────────────────────────────────────

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1;
// Occlusion par le relief : `icon-occlusion-opacity` n'est volontairement PAS
// défini. Absent, Mapbox masque entièrement les icônes derrière le relief
// seulement (même résultat que l'ancien `occludedOpacity: 0` du DOM). Le
// définir passe à un test de profondeur générique, et la ligne de trace —
// surélevée en 3D via `line-z-offset` — masquait alors les icônes.
/** Soulèvement au survol, identique à l'ancien CSS `.rv-poi-marker:hover`. */
const HOVER_SCALE = 1.03;
const HOVER_LIFT_PX = 4;
/** Un clic aussi proche (px d'écran) d'un POI dessiné l'ouvre encore. */
const HIT_TOLERANCE_PX = 3;
/** Demi-taille visible d'un POI rond (icon-size 1), en attendant que son sprite soit mesuré. */
const FALLBACK_HALF_EXTENT_PX = 11;
const POI_CURSOR_OWNER = 'poi-hover';
export const POI_GPU_SOURCE_ID = 'rv-poi-gpu-source';
const POI_GPU_LAYER_ID = 'rv-poi-gpu-symbols';
const POI_GPU_HOVER_LAYER_ID = 'rv-poi-gpu-hover';

function getMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

// ── Taille selon le zoom ──────────────────────────────────────────────

/** Ancien CSS : boîte = base * (0.8 + 0.35 * scale), scale = smoothstep(zoom). */
function getIconSizeAtZoom(zoom: number): number {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  const scale = lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress);
  return 0.8 + 0.35 * scale;
}

/** Échantillonnage linéaire par morceaux de la courbe smoothstep en expression de zoom. */
function buildIconSizeExpression(multiplier = 1): ExpressionSpecification {
  const stops: number[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i += 1) {
    const zoom = MARKER_MIN_SCALE_ZOOM + ((MARKER_MAX_SCALE_ZOOM - MARKER_MIN_SCALE_ZOOM) * i) / steps;
    stops.push(Number(zoom.toFixed(3)), Number((getIconSizeAtZoom(zoom) * multiplier).toFixed(4)));
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;
}

// ── GeoJSON ───────────────────────────────────────────────────────────

interface PoiGeoJsonProperties {
  key: string;
  icon: string;
  sort: number;
  name: string;
}

type PoiFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, PoiGeoJsonProperties>;

const EMPTY_COLLECTION: PoiFeatureCollection = { type: 'FeatureCollection', features: [] };

function poiDisplayName(feature: PoiFeature): string {
  return feature.name?.trim() || POI_LABELS[feature.category];
}

// ── Registre de test de clic (utilisé par les outils de carte qui cherchaient des marqueurs DOM) ──

const managersByMap = new WeakMap<MapboxMap, PoiMarkerManager>();

/**
 * Masque tous les POI pendant qu'une autre fonction a besoin d'une carte nette
 * (survol 3D : la trace seule). Survit aux rechargements de style ; la popup
 * et le survol sont abandonnés.
 */
export function setPoiLayersSuppressed(map: MapboxMap, suppressed: boolean): void {
  managersByMap.get(map)?.setSuppressed(suppressed);
}

/** POI rendu sous un point du canvas (ou à moins de `radiusPx`), le plus proche d'abord. */
export function queryPoiAtPoint(
  map: MapboxMap,
  point: { x: number; y: number },
  radiusPx = 0,
): PoiFeature | null {
  return managersByMap.get(map)?.queryAt(point, radiusPx) ?? null;
}

// ── Manager ───────────────────────────────────────────────────────────

/**
 * Possède la couche GPU des POI d'une instance de carte : enregistrement des
 * sprites, `setData` différentiel, survol / clic, popup partagée et démontage.
 * API publique identique à celle de l'ancien gestionnaire de marqueurs DOM.
 */
export class PoiMarkerManager {
  private readonly map: MapboxMap;
  private readonly getActions: () => UsePoiPopupActions;
  private readonly features = new Map<string, PoiFeature>();
  private readonly sprites = new Map<string, PoiSprite>();
  private readonly pendingSprites = new Map<string, Promise<void>>();
  private readonly pixelRatio = getPoiSpritePixelRatio();
  private data: PoiFeatureCollection = EMPTY_COLLECTION;
  /** Indice de chaque POI rendu dans `data`, qui est aussi son ordre de dessin. */
  private readonly drawRankByKey = new Map<string, number>();
  /** Plus grande distance dessinée depuis un ancrage parmi les sprites (icon-size 1). */
  private maxHitExtentPx = FALLBACK_HALF_EXTENT_PX;
  /** Signature de `data` (ce qui doit être à l'écran). */
  private renderedSignature = '';
  /** Signature de ce qui a été envoyé en dernier à la source. */
  private dataSignature = '';
  private syncToken = 0;
  private destroyed = false;
  private hoveredKey: string | null = null;
  private popup: mapboxgl.Popup | null = null;
  private popupKey: string | null = null;
  /**
   * POI dont le panneau était ouvert au moment de l'appui. Mapbox ferme le
   * popup au `preclick` (closeOnClick), avant le `click` du calque : sans ce
   * repère, recliquer le POI ouvert le rouvrait aussitôt au lieu de le fermer.
   */
  private pressedOpenPopupKey: string | null = null;
  private suppressed = false;
  private zoomFrameId: number | null = null;
  private raiseFrameId: number | null = null;
  private hoverFrameId: number | null = null;
  /** Dernière position du pointeur sur le canvas, résolue à l'image suivante. */
  private hoverPoint: { x: number; y: number } | null = null;

  constructor(map: MapboxMap, getActions: () => UsePoiPopupActions) {
    this.map = map;
    this.getActions = getActions;
    managersByMap.set(map, this);
    map.on('styledata', this.handleStyleData);
    map.on('zoom', this.handleZoom);
    map.on('mousedown', this.handleMapMouseDown);
    map.on('click', this.handleMapClick);
    map.on('mousemove', this.handleMapMouseMove);
    map.on('mouseout', this.handleMapMouseOut);
    this.ensureLayers();
  }

  /** Nombre d'objets actuellement rendus. */
  get size(): number {
    return this.features.size;
  }

  /**
   * Réconcilie les POI rendus avec `features`. Les variantes de sprite
   * manquantes sont d'abord rastérisées (asynchrone, une fois par variante) ;
   * la source GeoJSON n'est renvoyée que si l'ensemble rendu a vraiment changé.
   */
  sync(features: PoiFeature[]): void {
    this.features.clear();
    for (const feature of features) {
      this.features.set(getMarkerKey(feature), feature);
    }

    const token = ++this.syncToken;
    const waits: Promise<void>[] = [];
    for (const feature of this.features.values()) {
      const spec = getPoiSpriteSpec(feature);
      const id = getPoiSpriteId(spec);
      if (this.sprites.has(id)) continue;
      waits.push(this.loadSprite(id, spec));
    }

    if (waits.length === 0) {
      this.flush();
      return;
    }
    void Promise.all(waits).then(() => {
      if (this.destroyed || token !== this.syncToken) return;
      this.flush();
    });
  }

  /** Retire la couche, la popup et tous les écouteurs. */
  destroy(): void {
    this.destroyed = true;
    if (this.zoomFrameId != null) {
      window.cancelAnimationFrame(this.zoomFrameId);
      this.zoomFrameId = null;
    }
    if (this.raiseFrameId != null) {
      window.cancelAnimationFrame(this.raiseFrameId);
      this.raiseFrameId = null;
    }
    if (this.hoverFrameId != null) {
      window.cancelAnimationFrame(this.hoverFrameId);
      this.hoverFrameId = null;
    }
    this.map.off('styledata', this.handleStyleData);
    this.map.off('zoom', this.handleZoom);
    this.map.off('mousedown', this.handleMapMouseDown);
    this.map.off('click', this.handleMapClick);
    this.map.off('mousemove', this.handleMapMouseMove);
    this.map.off('mouseout', this.handleMapMouseOut);
    setMapCursor(this.map, POI_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.hover);
    this.popup?.remove();
    this.popup = null;
    this.popupKey = null;
    if (managersByMap.get(this.map) === this) managersByMap.delete(this.map);
    try {
      if (this.map.getLayer(POI_GPU_HOVER_LAYER_ID)) this.map.removeLayer(POI_GPU_HOVER_LAYER_ID);
      if (this.map.getLayer(POI_GPU_LAYER_ID)) this.map.removeLayer(POI_GPU_LAYER_ID);
      if (this.map.getSource(POI_GPU_SOURCE_ID)) this.map.removeSource(POI_GPU_SOURCE_ID);
      for (const id of this.sprites.keys()) {
        if (this.map.hasImage(id)) this.map.removeImage(id);
      }
    } catch {
      // Carte déjà démontée.
    }
    this.features.clear();
  }

  /**
   * Ouvre la popup d'un POI et centre la carte dessus.
   */
  openPoi(poiId: number | string, category?: string, coords?: { lat: number; lon: number }): boolean {
    const idStr = String(poiId);
    const strippedPrefix = idStr.replace(/^.*::/, '');
    const cleanId = strippedPrefix.replace(/^(poi-|feature-|poi-timeline-)/, '');
    let targetKey: string | null = null;

    for (const [key, feature] of this.features) {
      const featureId = String(feature.id);
      if (
        key === idStr ||
        key === strippedPrefix ||
        key.endsWith(`:${idStr}`) ||
        key.endsWith(`:${strippedPrefix}`) ||
        key.endsWith(`:${cleanId}`) ||
        featureId === idStr ||
        featureId === strippedPrefix ||
        featureId === cleanId ||
        (category && (
          key === `${category}:${idStr}` ||
          key === `${category}:${strippedPrefix}` ||
          key === `${category}:${cleanId}`
        ))
      ) {
        targetKey = key;
        break;
      }
    }

    if (!targetKey && coords) {
      let minDistanceSq = 0.001 * 0.001; // ~100 m
      for (const [key, feature] of this.features) {
        const dLat = feature.lat - coords.lat;
        const dLon = feature.lon - coords.lon;
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < minDistanceSq) {
          minDistanceSq = distSq;
          targetKey = key;
        }
      }
    }

    const target = targetKey ? this.features.get(targetKey) : undefined;
    if (!targetKey || !target) return false;

    if (this.popupKey === targetKey && this.popup?.isOpen()) {
      this.getActions().onSelectPoi?.(target);
    } else {
      this.openPopup(targetKey, target);
    }

    flyToPoi(this.map, { lon: target.lon, lat: target.lat });

    return true;
  }

  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    if (suppressed) {
      this.popup?.remove();
      this.setHovered(null);
    }
    this.applyVisibility();
  }

  /** POI le plus haut dessiné sous un point du canvas, sinon le plus proche à moins de `radiusPx` (3 px min). */
  queryAt(point: { x: number; y: number }, radiusPx: number): PoiFeature | null {
    const key = this.queryKeyAt(point, radiusPx);
    return key ? this.features.get(key) ?? null : null;
  }

  /** Ouvre le POI sous / autour d'un point du canvas. */
  activateAt(point: { x: number; y: number }, radiusPx: number): boolean {
    const key = this.queryKeyAt(point, radiusPx);
    const feature = key ? this.features.get(key) : undefined;
    if (!key || !feature) return false;
    this.openPopup(key, feature);
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Test de clic au pixel près. Mapbox ne fournit que les candidats — symboles
   * dont l'image coupe une boîte assez large pour qu'un pixel dessiné puisse
   * atteindre le point, occlusion par le relief comprise — puis le masque de
   * chaque candidat décide, à son ancrage projeté et à sa taille d'icône
   * actuelle (`pickPoiHit`).
   */
  private queryKeyAt(point: { x: number; y: number }, radiusPx: number): string | null {
    try {
      if (this.suppressed || !this.map.getLayer(POI_GPU_LAYER_ID)) return null;
      const tolerance = Math.max(HIT_TOLERANCE_PX, radiusPx);
      const size = getIconSizeAtZoom(this.map.getZoom());
      const reach = this.maxHitExtentPx * size * HOVER_SCALE + HOVER_LIFT_PX + tolerance;
      const hits = this.map.queryRenderedFeatures(
        [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]],
        { layers: [POI_GPU_LAYER_ID] },
      );
      if (hits.length === 0) return null;
      const candidates: PoiHitCandidate<string>[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        const key = String(hit.properties?.key ?? '');
        // Un objet à cheval sur plusieurs tuiles revient une fois par tuile.
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const feature = this.features.get(key);
        const sprite = feature ? this.sprites.get(getPoiSpriteId(getPoiSpriteSpec(feature))) : undefined;
        if (!feature || !sprite) continue;
        const anchor = this.map.project([feature.lon, feature.lat]);
        const placements = [{ x: anchor.x, y: anchor.y, scale: size }];
        // Le POI survolé est dessiné soulevé et agrandi : les deux positions
        // comptent, pour que le soulèvement ne le sorte jamais de sous le pointeur.
        if (key === this.hoveredKey) {
          placements.push({ x: anchor.x, y: anchor.y - HOVER_LIFT_PX, scale: size * HOVER_SCALE });
        }
        candidates.push({ key, mask: sprite.hitMask, drawRank: this.drawRankByKey.get(key) ?? 0, placements });
      }
      return pickPoiHit(candidates, point, tolerance);
    } catch {
      return null;
    }
  }

  private loadSprite(id: string, spec: PoiSpriteSpec): Promise<void> {
    let pending = this.pendingSprites.get(id);
    if (!pending) {
      pending = rasterizePoiSprite(spec, this.pixelRatio)
        .then((sprite) => {
          if (!sprite) return;
          this.sprites.set(id, sprite);
          const bounds = sprite.hitMask.bounds;
          if (bounds) {
            this.maxHitExtentPx = Math.max(
              this.maxHitExtentPx,
              -bounds.minX,
              bounds.maxX,
              -bounds.minY,
              bounds.maxY,
            );
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.pendingSprites.delete(id);
        });
      this.pendingSprites.set(id, pending);
    }
    return pending;
  }

  private ensureLayers(): boolean {
    if (this.destroyed) return false;
    const map = this.map;
    try {
      if (!map.getStyle()) return false;
    } catch {
      return false;
    }

    try {
      for (const sprite of this.sprites.values()) {
        if (!map.hasImage(sprite.id)) {
          map.addImage(sprite.id, sprite.image, { pixelRatio: sprite.pixelRatio });
        }
      }

      if (!map.getSource(POI_GPU_SOURCE_ID)) {
        map.addSource(POI_GPU_SOURCE_ID, {
          type: 'geojson',
          data: this.data,
          promoteId: 'key',
        });
      }

      const sharedLayout = {
        'icon-image': ['get', 'icon'] as ExpressionSpecification,
        'icon-anchor': 'center' as const,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport' as const,
        'icon-rotation-alignment': 'viewport' as const,
        'symbol-sort-key': ['get', 'sort'] as ExpressionSpecification,
      };

      if (!map.getLayer(POI_GPU_LAYER_ID)) {
        map.addLayer({
          id: POI_GPU_LAYER_ID,
          type: 'symbol',
          source: POI_GPU_SOURCE_ID,
          slot: 'top',
          layout: {
            ...sharedLayout,
            'icon-size': buildIconSizeExpression(),
          },
          paint: {
            'icon-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0,
              1,
            ],
            'icon-opacity-transition': { duration: 0, delay: 0 },
            'icon-emissive-strength': 1,
          },
        });
      }

      if (!map.getLayer(POI_GPU_HOVER_LAYER_ID)) {
        map.addLayer({
          id: POI_GPU_HOVER_LAYER_ID,
          type: 'symbol',
          source: POI_GPU_SOURCE_ID,
          slot: 'top',
          filter: ['==', ['get', 'key'], this.hoveredKey ?? ''],
          layout: {
            ...sharedLayout,
            'icon-size': buildIconSizeExpression(HOVER_SCALE),
          },
          paint: {
            'icon-translate': [0, -HOVER_LIFT_PX],
            'icon-translate-anchor': 'viewport',
            'icon-emissive-strength': 1,
          },
        });
      }
      this.applyVisibility();
      return true;
    } catch {
      return false;
    }
  }

  private applyVisibility(): void {
    const visibility = this.suppressed ? 'none' : 'visible';
    try {
      for (const layerId of [POI_GPU_LAYER_ID, POI_GPU_HOVER_LAYER_ID]) {
        if (this.map.getLayer(layerId) && this.map.getLayoutProperty(layerId, 'visibility') !== visibility) {
          this.map.setLayoutProperty(layerId, 'visibility', visibility);
        }
      }
    } catch {
      // Changement de style : réappliqué par ensureLayers au prochain styledata.
    }
  }

  private flush(): void {
    if (this.destroyed) return;

    const features: PoiFeatureCollection['features'] = [];
    const signatureParts: string[] = [];
    for (const [key, feature] of this.features) {
      const icon = getPoiSpriteId(getPoiSpriteSpec(feature));
      if (!this.sprites.has(icon)) continue;
      const sort = (feature.favorite ? 2 : 0) + ((feature.pauseDurationMin ?? 0) > 0 ? 1 : 0);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [feature.lon, feature.lat] },
        properties: { key, icon, sort, name: poiDisplayName(feature) },
      });
    }
    // Données dans l'ordre de dessin (tri stable sur la clé de tri) : favoris et
    // pauses en dernier, donc au-dessus, et l'indice est le rang de dessin du
    // test de clic.
    features.sort((a, b) => a.properties.sort - b.properties.sort);
    this.drawRankByKey.clear();
    features.forEach((entry, index) => {
      this.drawRankByKey.set(entry.properties.key, index);
      const [lon, lat] = entry.geometry.coordinates;
      signatureParts.push(`${entry.properties.key}|${entry.properties.icon}|${lon}|${lat}`);
    });
    this.data = { type: 'FeatureCollection', features };
    this.renderedSignature = signatureParts.join(';');

    // La popup suit son objet ; elle se ferme si le POI a disparu.
    if (this.popupKey && this.popup) {
      const current = this.features.get(this.popupKey);
      if (!current) {
        this.popup.remove();
      } else {
        this.popup.setLngLat([current.lon, current.lat]);
        // Le sprite a pu changer (favori / pause basculé depuis le menu).
        this.popup.setOffset(this.getPopupOffset(current));
      }
    }
    if (this.hoveredKey && !this.features.has(this.hoveredKey)) {
      this.setHovered(null);
    }

    if (!this.ensureLayers()) return;
    this.scheduleRaise();
    const source = this.map.getSource(POI_GPU_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    if (this.renderedSignature === this.dataSignature) return;
    this.dataSignature = this.renderedSignature;
    source.setData(this.data);
  }

  private openPopup(key: string, feature: PoiFeature): void {
    this.popup?.remove();

    const popup = new mapboxgl.Popup({
      className: 'rv-poi-popup',
      closeButton: false,
      closeOnClick: true,
      focusAfterOpen: false,
      maxWidth: 'none',
      offset: this.getPopupOffset(feature),
    });

    // Le DOM de la popup n'est construit qu'à l'ouverture — une seule popup existe à la fois.
    const refresh = (nextState?: PoiPopupState) => {
      const actions = this.getActions();
      popup.setDOMContent(buildPopupContent(
        feature,
        resolvePopupState(actions, feature, nextState),
        actions,
        refresh,
      ));
    };
    refresh();

    popup.on('close', () => {
      if (this.popup === popup) {
        this.popup = null;
        this.popupKey = null;
      }
    });

    this.popup = popup;
    this.popupKey = key;
    keepPopupInVisibleMap(popup, this.map);
    popup.setLngLat([feature.lon, feature.lat]).addTo(this.map);
    this.getActions().onSelectPoi?.(feature);
  }

  /**
   * Décalage de la popup qui garde le menu à l'écart de ce que le sprite
   * dessine vraiment, de quelque côté que Mapbox l'ancre (le sprite survolé est
   * agrandi et soulevé : pris en compte).
   */
  private getPopupOffset(feature: PoiFeature) {
    const size = getIconSizeAtZoom(this.map.getZoom()) * HOVER_SCALE;
    const bounds = this.sprites.get(getPoiSpriteId(getPoiSpriteSpec(feature)))?.hitMask.bounds;
    const fallback = FALLBACK_HALF_EXTENT_PX;
    return buildPopupClearanceOffset({
      above: (bounds ? Math.max(0, -bounds.minY) : fallback) * size + HOVER_LIFT_PX,
      below: (bounds ? Math.max(0, bounds.maxY) : fallback) * size,
      side: (bounds ? Math.max(-bounds.minX, bounds.maxX, 0) : fallback) * size,
    });
  }

  private setHovered(key: string | null): void {
    setMapCursor(this.map, POI_CURSOR_OWNER, key ? 'pointer' : null, MAP_CURSOR_PRIORITY.hover);
    if (key === this.hoveredKey) return;
    const map = this.map;
    try {
      if (this.hoveredKey && map.getSource(POI_GPU_SOURCE_ID)) {
        map.setFeatureState({ source: POI_GPU_SOURCE_ID, id: this.hoveredKey }, { hover: false });
      }
      this.hoveredKey = key;
      if (key && map.getSource(POI_GPU_SOURCE_ID)) {
        map.setFeatureState({ source: POI_GPU_SOURCE_ID, id: key }, { hover: true });
      }
      if (map.getLayer(POI_GPU_HOVER_LAYER_ID)) {
        map.setFilter(POI_GPU_HOVER_LAYER_ID, ['==', ['get', 'key'], key ?? '']);
      }
    } catch {
      this.hoveredKey = key;
    }
  }

  /**
   * Garde les couches des POI tout en haut de la pile : les lignes de trace (et
   * d'autres surcouches) sont ajoutées / réajoutées après nous et peindraient
   * sinon par-dessus les icônes. Ne déplace que si nécessaire, pour que le
   * `styledata` déclenché soit sans effet.
   */
  private raiseLayers(): void {
    const map = this.map;
    try {
      if (!map.getLayer(POI_GPU_LAYER_ID) || !map.getLayer(POI_GPU_HOVER_LAYER_ID)) return;
      const order = (map as unknown as { style?: { order?: string[] } }).style?.order;
      if (!order || order.length < 2) return;
      const last = order[order.length - 1];
      const beforeLast = order[order.length - 2];
      if (beforeLast === POI_GPU_LAYER_ID && last === POI_GPU_HOVER_LAYER_ID) return;
      map.moveLayer(POI_GPU_LAYER_ID);
      map.moveLayer(POI_GPU_HOVER_LAYER_ID);
    } catch {
      // Style en cours de rechargement.
    }
  }

  private readonly scheduleRaise = (): void => {
    if (this.raiseFrameId != null || this.destroyed) return;
    this.raiseFrameId = window.requestAnimationFrame(() => {
      this.raiseFrameId = null;
      if (!this.destroyed) this.raiseLayers();
    });
  };

  private readonly handleStyleData = (): void => {
    if (this.destroyed) return;
    let missing = false;
    try {
      missing = !this.map.getLayer(POI_GPU_LAYER_ID) || !this.map.getSource(POI_GPU_SOURCE_ID);
    } catch {
      return;
    }
    if (!missing) {
      this.scheduleRaise();
      return;
    }
    // Un rechargement de style a effacé source, couches et images : on réinstalle tout.
    this.dataSignature = '';
    if (this.ensureLayers()) {
      (this.map.getSource(POI_GPU_SOURCE_ID) as GeoJSONSource | undefined)?.setData(this.data);
      this.dataSignature = this.renderedSignature;
    }
  };

  private readonly handleZoom = (): void => {
    if (!this.popup || this.zoomFrameId != null) return;
    this.zoomFrameId = window.requestAnimationFrame(() => {
      this.zoomFrameId = null;
      const feature = this.popupKey ? this.features.get(this.popupKey) : undefined;
      if (feature) this.popup?.setOffset(this.getPopupOffset(feature));
    });
  };

  private readonly handleMapMouseDown = (): void => {
    this.pressedOpenPopupKey = this.popup?.isOpen() ? this.popupKey : null;
  };

  private readonly handleMapClick = (event: MapMouseEvent): void => {
    // Un marqueur DOM (waypoint, pause, départ…) posé sur le POI gère son
    // propre clic : sans ça, les deux panneaux s'ouvraient ensemble.
    if (isEventFromDomMarker(event)) {
      this.pressedOpenPopupKey = null;
      return;
    }
    const key = this.queryKeyAt(event.point, 0);
    const feature = key ? this.features.get(key) : undefined;
    const pressedOpenKey = this.pressedOpenPopupKey;
    this.pressedOpenPopupKey = null;
    if (!key || !feature) return;
    // Second clic sur le POI dont le panneau est ouvert : il se ferme, comme
    // un clic ailleurs sur la carte.
    if (key === pressedOpenKey) {
      this.popup?.remove();
      return;
    }
    this.openPopup(key, feature);
  };

  /** Survol, résolu une fois par image sur la dernière position du pointeur. */
  private readonly handleMapMouseMove = (event: MapMouseEvent): void => {
    if (this.destroyed) return;
    if (this.suppressed || isEventFromDomMarker(event)) {
      this.hoverPoint = null;
      this.setHovered(null);
      return;
    }
    // Bouton enfoncé : un déplacement ou un glisser possède le pointeur, le survol reste tel quel.
    if ((event.originalEvent as MouseEvent | undefined)?.buttons) return;
    this.hoverPoint = { x: event.point.x, y: event.point.y };
    if (this.hoverFrameId != null) return;
    this.hoverFrameId = window.requestAnimationFrame(() => {
      this.hoverFrameId = null;
      const point = this.hoverPoint;
      if (!point || this.destroyed || this.map.isMoving()) return;
      this.setHovered(this.queryKeyAt(point, 0));
    });
  };

  private readonly handleMapMouseOut = (): void => {
    this.hoverPoint = null;
    this.setHovered(null);
  };
}

// ── Aides mathématiques ───────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}
