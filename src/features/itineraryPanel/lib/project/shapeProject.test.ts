import { describe, expect, it } from 'vitest';

import type { ItineraryProject } from '../../types';

import { createDefaultItinerary, normalizeItineraryProject } from './defaultState';
import { shapeProject } from './shapeProject';

/** Comme le ProjectStore : forme garantie, puis normalisation. */
const prepare = (project: unknown) => normalizeItineraryProject(shapeProject(project as ItineraryProject));

describe('shapeProject : forme garantie (document d’un autre éditeur, cloud, fichier tiers)', () => {
  it('itinéraire « nu » (id + nom, créé par un éditeur malveillant) : lisible par l’interface', () => {
    const [itinerary] = prepare({ itineraries: [{ id: 'evil', name: 'Piège' }], activeItineraryId: 'evil' }).itineraries;
    expect(itinerary.timeline).toEqual([]);
    expect(typeof itinerary.color).toBe('string');
    expect(typeof itinerary.priorities.elevation).toBe('number');
    expect(typeof itinerary.rhythm.startTime).toBe('string');
  });

  it('types faux : remplacés par le défaut ; itinéraire sans id : écarté ; liste d’itinéraires illisible : vide', () => {
    const valid = createDefaultItinerary();
    const project = prepare({
      itineraries: [
        {
          ...valid,
          name: { toString: 1 },
          color: 'red;background:url(x)',
          priorities: { ...valid.priorities, elevation: { nested: true } },
          rhythm: { ...valid.rhythm, startTime: { h: 9 } },
          timeline: [{ id: 'a', kind: 'start', label: null, lat: '45' }, 'pas une ligne', { kind: 'end' }],
          gpxRoute: { points: 5 },
          metrics: [[1]],
        },
        { name: 'sans id' },
      ],
      activeItineraryId: valid.id,
    });
    const [itinerary, ...rest] = project.itineraries;
    expect(rest).toEqual([]);
    expect(typeof itinerary.name).toBe('string');
    expect(itinerary.color).toMatch(/^#/);
    expect(typeof itinerary.priorities.elevation).toBe('number');
    expect(itinerary.rhythm.startTime).toBe('09:30');
    expect(itinerary.timeline).toEqual([{ id: 'a', kind: 'start', label: '' }]);
    expect(itinerary.gpxRoute).toBeUndefined();
    expect(itinerary.metrics).toBeUndefined();
    expect(prepare({ itineraries: 'x' }).itineraries).toEqual([]);
  });

  it('projet conforme : rendu tel quel (même objet, aucune copie)', () => {
    const itinerary = createDefaultItinerary();
    const project = { name: 'Tour', itineraries: [itinerary], activeItineraryId: itinerary.id } as unknown as ItineraryProject;
    expect(shapeProject(project)).toBe(project);
  });
});
