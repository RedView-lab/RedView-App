// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { buildImportedGpxWaypoints } from '@/features/itineraryPanel/components/ItineraryPanelContainer/importedGpxWaypoints';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { parseGpxText } from '@/features/poi/lib/gpx-parse';
import type { PoiFeature } from '@/features/poi/types';

import { buildItineraryGpx } from './exportGpx';

/**
 * Un GPX exporté par RedView (noms au format GPS, types Garmin) se réimporte
 * à l'identique : catégorie exacte, nom de la feuille de route, favori.
 */

const points = Array.from({ length: 200 }, (_, i) => ({ lat: 44 + i * 0.001, lon: 6, elevationM: 400 + i, distanceM: i * 110.5 }));
const eastOf = (i: number, meters: number) => ({ lat: points[i]!.lat, lon: 6 + meters / (111_320 * Math.cos((44 * Math.PI) / 180)) });

const features: PoiFeature[] = [
  { id: 1, ...eastOf(30, -10), category: 'spring', name: null, tags: {} },
  { id: 2, ...eastOf(80, 4), category: 'bakery', name: 'Chez Zoé', tags: {} },
  { id: 3, ...eastOf(150, 25), category: 'camp_site', name: 'Camping du Lac', tags: {} },
];

const itinerary = {
  id: 'rt',
  name: 'Aller-retour GPX',
  discipline: 'road',
  rhythm: { startDate: '2026-10-12', startTime: '06:00' },
  gpxRoute: { name: 'Aller-retour GPX', points },
  poiFeatures: features,
  timeline: [
    { id: 'start', kind: 'start', label: 'A', lat: points[0]!.lat, lon: 6, distanceKm: 0 },
    { id: 'poi-1', kind: 'poi', label: "Source d'eau", poiCategory: 'fountains', osmId: 1, ...eastOf(30, -10), distanceKm: 3.3, visible: true },
    { id: 'poi-2', kind: 'poi', label: '7-19 Chez Zoé', labelEdited: true, poiCategory: 'bakeries', osmId: 2, ...eastOf(80, 4), distanceKm: 8.8, visible: true, favorite: true },
    { id: 'wpt', kind: 'waypoint', label: 'Col', lat: points[120]!.lat, lon: 6, distanceKm: 13.3 },
    { id: 'poi-3', kind: 'poi', label: 'Camping du Lac', poiCategory: 'hotels', osmId: 3, ...eastOf(150, 25), distanceKm: 16.6, visible: true },
    { id: 'end', kind: 'end', label: 'B', lat: points[199]!.lat, lon: 6, distanceKm: 22 },
  ],
} as unknown as Itinerary;

describe('GPX RedView : aller-retour export → import', () => {
  it('catégorie exacte, nom de la feuille de route, favori, point de passage', () => {
    const gpx = buildItineraryGpx(itinerary, { locale: 'fr', pois: 'all' });
    const route = parseGpxText(gpx);
    expect(route.creator).toBe('RedView');
    const imported = buildImportedGpxWaypoints(route, points, 7);

    expect(imported.poiFeatures.map((feature) => [feature.category, feature.name, feature.favorite])).toEqual([
      ['spring', "Source d'eau", false],
      ['bakery', '7-19 Chez Zoé', true],
      ['camp_site', 'Camping du Lac', false],
    ]);
    expect(imported.waypointRows.map((row) => row.label)).toEqual(['Col']);
  });

  it('noms GPS dans le fichier', () => {
    const names = [...buildItineraryGpx(itinerary, { locale: 'fr', pois: 'all' }).matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]);
    expect(names).toEqual(['Aller-retour GPX', 'EAU_G10', 'BOU_D04_7-19 Chez Zoé', 'Col', 'CAM_D25_Camping du Lac', 'Aller-retour GPX']);
  });
});

describe('GPX tiers', () => {
  const wrap = (wpt: string) => `<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect"><wpt lat="44.05" lon="6.0001">${wpt}</wpt><trk><trkseg>${points.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"/>`).join('')}</trkseg></trk></gpx>`;

  it('types Garmin (Garmin Connect) relus comme catégories', () => {
    const imported = buildImportedGpxWaypoints(parseGpxText(wrap('<name>Fontaine</name><type>WATER</type>')), points, 1);
    expect(imported.poiFeatures.map((feature) => feature.category)).toEqual(['drinking_water']);
  });

  it('clés hostiles (constructor, __proto__) : un point de passage, jamais une exception', () => {
    for (const wpt of ['<name>x</name><type>constructor</type><sym>__proto__</sym>', '<name>y</name><sym>constructor</sym>', '<name>z</name><extensions><redview:category>toString</redview:category></extensions>']) {
      const imported = buildImportedGpxWaypoints(parseGpxText(wrap(wpt)), points, 1);
      expect(imported.poiFeatures).toEqual([]);
      expect(imported.waypointRows).toHaveLength(1);
    }
  });
});
