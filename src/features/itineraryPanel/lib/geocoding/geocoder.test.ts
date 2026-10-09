import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/map3d/lib/mapbox.config', () => ({ MAPBOX_TOKEN: 'pk.test' }));

const { canSearchLandmarks, geocodePlaces } = await import('./geocoder');

function stubProviders() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/geocode-iconic')) {
      return new Response(JSON.stringify([
        { place_id: 1, osm_type: 'node', osm_id: 7, name: 'Col du Galibier', display_name: 'Col du Galibier, Savoie, France', lat: '45.064', lon: '6.408', type: 'mountain_pass', extratags: { wikipedia: 'fr:Col du Galibier', ele: '2642' } },
      ]), { status: 200 });
    }
    return new Response(JSON.stringify({
      features: [{ id: 'place.1', text: 'Valloire', place_name: 'Valloire, Savoie, France', center: [6.43, 45.16], place_type: ['place'] }],
    }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calledUrls = (fetchMock: ReturnType<typeof stubProviders>) => fetchMock.mock.calls.map(([input]) => String(input));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('geocodePlaces — lieux d’OpenStreetMap seulement sur demande', () => {
  it('n’interroge jamais Nominatim pendant la frappe (politique d’usage : pas d’autocomplétion)', async () => {
    const fetchMock = stubProviders();
    const results = await geocodePlaces('Col du Galibier frappe', { countries: 'fr' });
    expect(calledUrls(fetchMock).some((url) => url.includes('geocode-iconic'))).toBe(false);
    expect(results.every((result) => result.source === 'mapbox')).toBe(true);
  });

  it('ajoute les lieux d’OpenStreetMap, marqués comme tels, quand l’utilisateur les demande', async () => {
    const fetchMock = stubProviders();
    const results = await geocodePlaces('Col du Galibier', { countries: 'fr', includeLandmarks: true });
    expect(calledUrls(fetchMock).filter((url) => url.includes('geocode-iconic'))).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Col du Galibier', source: 'osm' });
  });

  it('garde en cache séparément la recherche simple et la recherche avec OpenStreetMap', async () => {
    const fetchMock = stubProviders();
    await geocodePlaces('Lac de Roselend', { countries: 'fr' });
    await geocodePlaces('Lac de Roselend', { countries: 'fr', includeLandmarks: true });
    expect(calledUrls(fetchMock).filter((url) => url.includes('geocode-iconic'))).toHaveLength(1);
  });

  it('ne propose la recherche d’OpenStreetMap que pour une saisie de mots d’au moins 4 lettres', () => {
    expect(canSearchLandmarks('Galibier')).toBe(true);
    expect(canSearchLandmarks('Col')).toBe(false);
    expect(canSearchLandmarks('12 rue de la Paix')).toBe(false);
  });
});
