// @vitest-environment happy-dom
import { Decoder, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';

import type { Itinerary } from '@/features/itineraryPanel/types';

import { buildItineraryFitCourse } from './exportFit';
import { buildItineraryGpx } from './exportGpx';
import { buildExportFileName } from './exportHelpers';
import { buildItineraryKml } from './exportKml';

/**
 * Exports avec des noms limites (projet, itinéraire, POI) : XML toujours
 * valide et nom restitué, FIT lisible par le décodeur de Garmin, nom de
 * fichier sûr.
 */

const HOSTILE = 'R&D <Col> "du" l\'Iseran 🚴 東京\u0007￾';
const READABLE = 'R&D <Col> "du" l\'Iseran 🚴 東京';

function itinerary(name: string, poiName: string): Itinerary {
  const points = Array.from({ length: 50 }, (_, i) => ({ lat: 45.4 + i * 0.001, lon: 7.0, elevationM: 2000 + i, distanceM: i * 111 }));
  return {
    id: 'it',
    name,
    discipline: 'road',
    gpxRoute: { name, points },
    poiFeatures: [],
    timeline: [
      { id: 'start', label: 'Départ', kind: 'start', lat: points[0]!.lat, lon: 7, distanceKm: 0 },
      { id: 'poi', label: poiName, name: poiName, kind: 'poi', poiCategory: 'fountains', osmId: 1, lat: points[20]!.lat, lon: 7, distanceKm: 2.22, visible: true, favorite: true },
      { id: 'end', label: 'Arrivée', kind: 'end', lat: points[49]!.lat, lon: 7, distanceKm: 5.44 },
    ],
  } as unknown as Itinerary;
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('exports avec des noms limites', () => {
  it('GPX et KML : XML valide, nom restitué sans les caractères interdits par XML', () => {
    const route = itinerary(HOSTILE, HOSTILE);
    const gpx = parseXml(buildItineraryGpx(route));
    expect(gpx.getElementsByTagName('trk')[0]?.getElementsByTagName('name')[0]?.textContent).toBe(READABLE);
    const kml = parseXml(buildItineraryKml(route));
    expect([...kml.getElementsByTagName('name')].map((node) => node.textContent)).toContain(READABLE);
  });

  it('FIT : nom de 450 octets accepté, fichier lisible par le décodeur de Garmin', () => {
    const long = '東京ライド'.repeat(30);
    const bytes = buildItineraryFitCourse(itinerary(long, `${'🚴'.repeat(80)}`));
    const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
    expect(decoder.checkIntegrity()).toBe(true);
    const { messages, errors } = decoder.read();
    expect(errors).toEqual([]);
    expect(long.startsWith(messages.courseMesgs?.[0]?.name as string)).toBe(true);
  });

  it('nom de fichier : lettres de toute écriture gardées, rien d’interdit', () => {
    expect(buildExportFileName(itinerary('東京ライド', 'x'), 'gpx')).toBe('東京ライド.gpx');
    expect(buildExportFileName(itinerary(HOSTILE, 'x'), 'fit')).toBe('r-d-col-du-l-iseran-東京.fit');
    expect(buildExportFileName(itinerary('🚴🚴', 'x'), 'kml')).toBe('itinerary.kml');
  });
});
