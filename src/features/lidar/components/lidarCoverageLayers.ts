import type { Map as MapboxMap, PointLike } from 'mapbox-gl';
import franceCoverageUrl from '../lib/franceCoverage.json?url';
import japanCoverageUrl from '../lib/japan/japanCoverage.json?url';
import nzCoverageUrl from '../lib/nz/nzCoverage.json?url';
import swissCoverageUrl from '../lib/swiss/swissCoverage.json?url';
import netherlandsCoverageUrl from '../lib/netherlands/ahnCoverage.json?url';
import flandersCoverageUrl from '../lib/flanders/dhmvCoverage.json?url';
import type { JapanZoneNumber } from '../lib/japan';

/**
 * Overlay vert des zones où un nuage de points LiDAR dense est téléchargeable
 * (France et La Réunion, Suisse, Pays-Bas, Flandre, Japon, Nouvelle-Zélande), affiché pendant le
 * mode téléchargement LiDAR.
 *
 * Les polygones sont générés à partir des listes de fichiers publiés
 * (`npm run lidar:index`) : une zone verte a toujours au moins un fichier
 * derrière. La France y est découpée par la Suisse, les Pays-Bas et la
 * Flandre (et la Flandre par les Pays-Bas), prioritaires au clic, pour que
 * les overlays ne se superposent pas. Chaque GeoJSON n'est chargé
 * (par le worker Mapbox) que lorsque la vue recoupe une de ses emprises.
 */

interface CoverageArea {
  sourceId: string;
  layerId: string;
  url: string;
  /** Emprises [ouest, sud, est, nord] du contenu du fichier. */
  bboxes: readonly Bbox[];
}

type Bbox = readonly [number, number, number, number];

const JAPAN_FILL_ID = 'lidar-coverage-jp-fill';

const COVERAGE_AREAS: readonly CoverageArea[] = [
  {
    sourceId: 'lidar-coverage-fr',
    layerId: 'lidar-coverage-fr-fill',
    url: franceCoverageUrl,
    bboxes: [[-5.6, 41.3, 9.7, 51.2], [55.1, -21.5, 55.9, -20.8]],
  },
  { sourceId: 'lidar-coverage-ch', layerId: 'lidar-coverage-ch-fill', url: swissCoverageUrl, bboxes: [[5.9, 45.8, 10.6, 47.9]] },
  { sourceId: 'lidar-coverage-nl', layerId: 'lidar-coverage-nl-fill', url: netherlandsCoverageUrl, bboxes: [[3.2, 50.7, 7.3, 53.7]] },
  { sourceId: 'lidar-coverage-be', layerId: 'lidar-coverage-be-fill', url: flandersCoverageUrl, bboxes: [[2.4, 50.6, 6.0, 51.6]] },
  { sourceId: 'lidar-coverage-jp', layerId: JAPAN_FILL_ID, url: japanCoverageUrl, bboxes: [[122, 20, 154.5, 46]] },
  { sourceId: 'lidar-coverage-nz', layerId: 'lidar-coverage-nz-fill', url: nzCoverageUrl, bboxes: [[165.5, -47.8, 179.5, -33.8]] },
];

function viewIntersects(map: MapboxMap, bboxes: readonly Bbox[]): boolean {
  try {
    const bounds = map.getBounds();
    if (!bounds) return false;
    return bboxes.some(([west, south, east, north]) =>
      bounds.getWest() <= east && bounds.getEast() >= west && bounds.getSouth() <= north && bounds.getNorth() >= south);
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
        if (!viewIntersects(map, area.bboxes)) continue;
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
