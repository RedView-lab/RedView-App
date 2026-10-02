import type { Map as MapboxMap, PointLike } from 'mapbox-gl';
import japanCoverageUrl from '../lib/japan/japanCoverage.json?url';
import nzCoverageUrl from '../lib/nz/nzCoverage.json?url';
import type { JapanZoneNumber } from '../lib/japan';

/**
 * Overlay vert des zones où un nuage de points LiDAR dense est téléchargeable
 * (Japon, Nouvelle-Zélande), affiché pendant le mode téléchargement LiDAR.
 *
 * Les polygones sont générés avec les index de fichiers (`npm run lidar:index`) :
 * une zone verte a toujours au moins un fichier derrière. Chaque GeoJSON n'est
 * chargé (par le worker Mapbox) que lorsque la vue recoupe son pays.
 */

interface CoverageArea {
  sourceId: string;
  layerId: string;
  url: string;
  /** [ouest, sud, est, nord] */
  bbox: [number, number, number, number];
}

const JAPAN_FILL_ID = 'lidar-coverage-jp-fill';

const COVERAGE_AREAS: readonly CoverageArea[] = [
  { sourceId: 'lidar-coverage-jp', layerId: JAPAN_FILL_ID, url: japanCoverageUrl, bbox: [122, 20, 154.5, 46] },
  { sourceId: 'lidar-coverage-nz', layerId: 'lidar-coverage-nz-fill', url: nzCoverageUrl, bbox: [165.5, -47.8, 179.5, -33.8] },
];

function viewIntersects(map: MapboxMap, [west, south, east, north]: CoverageArea['bbox']): boolean {
  try {
    const bounds = map.getBounds();
    if (!bounds) return false;
    return bounds.getWest() <= east && bounds.getEast() >= west && bounds.getSouth() <= north && bounds.getNorth() >= south;
  } catch {
    return false;
  }
}

function removeArea(map: MapboxMap, area: CoverageArea): void {
  try {
    if (map.getLayer(area.layerId)) map.removeLayer(area.layerId);
    if (map.getSource(area.sourceId)) map.removeSource(area.sourceId);
  } catch {
    /* la carte peut être en cours de destruction */
  }
}

/**
 * Ajoute (ou retire) les couches de couverture. À appeler avant d'empiler les
 * couches de sélection : l'overlay reste sous la dalle survolée / choisie.
 */
export function syncLidarCoverageLayers(map: MapboxMap, visible: boolean): void {
  for (const area of COVERAGE_AREAS) {
    if (!visible) {
      removeArea(map, area);
      continue;
    }
    try {
      // Une fois chargée, la source reste tant que le mode est actif.
      if (!map.getSource(area.sourceId)) {
        if (!viewIntersects(map, area.bbox)) continue;
        map.addSource(area.sourceId, { type: 'geojson', data: area.url, maxzoom: 12 });
      }
      if (!map.getLayer(area.layerId)) {
        map.addLayer({
          id: area.layerId,
          type: 'fill',
          source: area.sourceId,
          slot: 'top',
          paint: {
            'fill-color': '#30d158',
            'fill-opacity': 0.18,
            'fill-emissive-strength': 1,
          },
        });
      }
    } catch {
      /* graphe de style en cours de reconstruction : nouvel essai au prochain sync */
    }
  }
}

export function removeLidarCoverageLayers(map: MapboxMap): void {
  for (const area of COVERAGE_AREAS) removeArea(map, area);
}

/**
 * Zone JGD2011 des données sous le pointeur. Les fichiers japonais sont dans
 * la zone de leur préfecture, que la détection géographique de
 * `detectJapanZone` ne retrouve pas toujours (Izu, est du Yamanashi) : la
 * dalle doit être calculée dans la zone des données pour que le viewer
 * géoréférence le fichier correctement.
 */
export function lidarCoverageJapanZoneAt(map: MapboxMap, point: PointLike): JapanZoneNumber | undefined {
  try {
    if (!map.getLayer(JAPAN_FILL_ID)) return undefined;
    const zone = map.queryRenderedFeatures(point, { layers: [JAPAN_FILL_ID] })[0]?.properties?.zone;
    return typeof zone === 'number' && zone >= 1 && zone <= 19 ? (zone as JapanZoneNumber) : undefined;
  } catch {
    return undefined;
  }
}
