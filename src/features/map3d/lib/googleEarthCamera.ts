import type { Map as MapboxMap, PaddingOptions } from 'mapbox-gl';
import {
  enuBetween,
  googleEarthViewFromCamera,
  offsetGeoPoint,
  type Enu,
  type GeoPoint,
  type GoogleEarthView,
} from '@/shared/lib/googleEarthView';

/**
 * Caméra de la carte 3D → vue Google Earth (touche M).
 *
 * Même position, même cap, même inclinaison et même champ vertical que la
 * caméra Mapbox, sur toute la hauteur du canvas : le canvas couvre la fenêtre
 * (les panneaux flottent dessus), donc un onglet Google Earth de la même
 * fenêtre montre la même image, superposable au pixel près — panneaux de
 * RedView en moins. Viser le centre de la zone entre les panneaux tournerait la
 * caméra au lieu de décaler l'image : ≈ 5° de rotation apparente au bas de
 * l'écran (mesuré), pour un cadrage qu'aucune caméra symétrique ne reproduit.
 * Seul le padding de Mapbox (décentrement de la FreeCam pour viser au-dessus de
 * l'horizon) se traduit en visée : bissectrice des bords du canvas.
 * Le relief de la carte est exagéré (×1,5) : la caméra est descendue d'autant
 * que le point visé, qui garde son altitude réelle, à la même distance.
 */

const DEG = Math.PI / 180;
/** Champ vertical par défaut de Mapbox (2·atan(1/3) rad). */
const MAPBOX_DEFAULT_FOV_DEG = (2 * Math.atan(1 / 3)) / DEG;
/** Visée au ciel (au-dessus de l'horizon) : point visé à cette distance, en l'air. */
const SKY_TARGET_DISTANCE_M = 1000;
/** Sous ce zoom en projection globe, la carte n'est plus plate : vue approchée depuis le centre. */
const GLOBE_FLAT_ZOOM = 6;
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;

export interface MapCameraShape {
  /** Taille de la carte en px de mise en page (`clientWidth/Height` du canvas). */
  widthPx: number;
  heightPx: number;
  /** Champ vertical de Mapbox, sur toute la hauteur de la carte (degrés). */
  fovDeg: number;
  bearingDeg: number;
  pitchDeg: number;
  /** Padding Mapbox : le centre de perspective est au centre de la zone non paddée. */
  padding: Required<PaddingOptions>;
}

export interface MapAim {
  /** Pixel visé (px de mise en page de la carte). */
  x: number;
  y: number;
  /** Direction unitaire de la visée (est, nord, haut). */
  direction: Enu;
  /** Haut de l'écran Mapbox (est, nord, haut) : donne le cap d'une visée verticale. */
  up: Enu;
  /** Hauteur angulaire du canvas le long de la visée (degrés). */
  fovYDeg: number;
}

/**
 * Visée du canvas : bissectrice des angles de ses bords (gauche/droite, puis
 * haut/bas le long de la colonne visée), champ = écart entre haut et bas.
 * Sans padding : l'axe et le champ de Mapbox, exactement.
 */
export function mapAimRay(shape: MapCameraShape): MapAim {
  const { widthPx: w, heightPx: h, padding } = shape;
  const focal = (0.5 * h) / Math.tan((shape.fovDeg * DEG) / 2);
  const cx = padding.left + (w - padding.left - padding.right) / 2;
  const cy = padding.top + (h - padding.top - padding.bottom) / 2;

  const yaw = (Math.atan(-cx / focal) + Math.atan((w - cx) / focal)) / 2;
  const dx = focal * Math.tan(yaw);
  const columnFocal = Math.hypot(focal, dx);
  const angleTop = Math.atan(-cy / columnFocal);
  const angleBottom = Math.atan((h - cy) / columnFocal);
  const dy = columnFocal * Math.tan((angleTop + angleBottom) / 2);

  // Repère caméra en (est, nord, haut) : avant, droite de l'écran, haut de l'écran.
  const b = shape.bearingDeg * DEG;
  const p = shape.pitchDeg * DEG;
  const forward: Enu = [Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), -Math.cos(p)];
  const rightAxis: Enu = [Math.cos(b), -Math.sin(b), 0];
  const up: Enu = [
    rightAxis[1] * forward[2] - rightAxis[2] * forward[1],
    rightAxis[2] * forward[0] - rightAxis[0] * forward[2],
    rightAxis[0] * forward[1] - rightAxis[1] * forward[0],
  ];
  const ray: Enu = [0, 1, 2].map((i) => focal * forward[i] + dx * rightAxis[i] - dy * up[i]) as Enu;
  const length = Math.hypot(...ray);
  return {
    x: cx + dx,
    y: cy + dy,
    direction: ray.map((v) => v / length) as Enu,
    up,
    fovYDeg: (angleBottom - angleTop) / DEG,
  };
}

interface TransformInternals {
  fov?: number;
  isPointAboveHorizon?: (point: { x: number; y: number }) => boolean;
}

function transformOf(map: MapboxMap): TransformInternals {
  return (map as unknown as { transform?: TransformInternals }).transform ?? {};
}

/** Altitude réelle et altitude dessinée (exagérée) du relief en un point. */
function terrainHeights(map: MapboxMap, lngLat: { lng: number; lat: number }): { real: number; drawn: number } {
  const real = map.queryTerrainElevation(lngLat, { exaggerated: false });
  const drawn = map.queryTerrainElevation(lngLat, { exaggerated: true });
  return { real: real ?? 0, drawn: drawn ?? real ?? 0 };
}

/** Globe à petit zoom : centre, cap, inclinaison et distance de la caméra Mapbox. */
function viewFromCenter(map: MapboxMap, fovDeg: number, heightPx: number): GoogleEarthView | null {
  const center = map.getCenter();
  const focal = (0.5 * heightPx) / Math.tan((fovDeg * DEG) / 2);
  const pixelsPerMeter = (512 * 2 ** map.getZoom()) / (EARTH_CIRCUMFERENCE_M * Math.cos(center.lat * DEG));
  const distanceM = focal / pixelsPerMeter;
  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  return {
    target: { lon: center.lng, lat: center.lat, altitudeM: terrainHeights(map, center).real },
    distanceM,
    fovYDeg: fovDeg,
    headingDeg: map.getBearing(),
    tiltDeg: map.getPitch(),
  };
}

export function googleEarthViewFromMap(map: MapboxMap): GoogleEarthView | null {
  const canvas = map.getCanvas();
  const widthPx = canvas.clientWidth;
  const heightPx = canvas.clientHeight;
  if (!(widthPx > 0 && heightPx > 0)) return null;
  const transform = transformOf(map);
  const fovDeg = typeof transform.fov === 'number' && transform.fov > 0 ? transform.fov : MAPBOX_DEFAULT_FOV_DEG;

  if (map.getProjection?.()?.name === 'globe' && map.getZoom() < GLOBE_FLAT_ZOOM) {
    return viewFromCenter(map, fovDeg, heightPx);
  }

  const position = map.getFreeCameraOptions().position;
  if (!position) return viewFromCenter(map, fovDeg, heightPx);
  const cameraLngLat = position.toLngLat();
  const cameraDrawn: GeoPoint = { lon: cameraLngLat.lng, lat: cameraLngLat.lat, altitudeM: position.toAltitude() };

  const padding = map.getPadding();
  const aim = mapAimRay({
    widthPx,
    heightPx,
    fovDeg,
    bearingDeg: map.getBearing(),
    pitchDeg: map.getPitch(),
    padding: { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 },
  });

  // Point visé : le relief sous le pixel visé (raycast de Mapbox, donc sur son
  // propre rayon), à son altitude réelle ; la caméra descend de l'exagération.
  const aboveHorizon = transform.isPointAboveHorizon?.({ x: aim.x, y: aim.y }) ?? false;
  if (!aboveHorizon) {
    const hit = map.unproject([aim.x, aim.y]);
    const heights = terrainHeights(map, hit);
    const toHit = enuBetween(cameraDrawn, { lon: hit.lng, lat: hit.lat, altitudeM: heights.drawn });
    if (toHit[0] * aim.direction[0] + toHit[1] * aim.direction[1] + toHit[2] * aim.direction[2] > 0) {
      const camera: GeoPoint = { ...cameraDrawn, altitudeM: cameraDrawn.altitudeM - (heights.drawn - heights.real) };
      return googleEarthViewFromCamera(camera, { lon: hit.lng, lat: hit.lat, altitudeM: heights.real }, aim.fovYDeg, aim.up);
    }
  }
  const heights = terrainHeights(map, map.getCenter());
  const camera: GeoPoint = { ...cameraDrawn, altitudeM: cameraDrawn.altitudeM - (heights.drawn - heights.real) };
  const target = offsetGeoPoint(camera, aim.direction.map((v) => v * SKY_TARGET_DISTANCE_M) as Enu);
  return googleEarthViewFromCamera(camera, target, aim.fovYDeg, aim.up);
}
