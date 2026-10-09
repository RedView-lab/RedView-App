// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import type { GeocodeOptions, GeocodeSuggestion } from '../../../lib/geocoding/geocoder';

const geocodePlaces = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/geocoding', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/geocoding')>()),
  geocodePlaces,
}));

const { PlaceSearchInput } = await import('./PlaceSearchInput');

const VALLOIRE: GeocodeSuggestion = { id: 'place.1', name: 'Valloire', fullName: 'Valloire, Savoie, France', lon: 6.43, lat: 45.16, source: 'mapbox' };
const GALIBIER: GeocodeSuggestion = { id: 'osm:node:7', name: 'Col du Galibier', fullName: 'Col du Galibier, Savoie, France', lon: 6.408, lat: 45.064, source: 'osm' };

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Anti-rebond (0 ms ici) puis réponse du géocodeur. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const landmarksRow = () => options().find((option) => option.textContent?.includes('OpenStreetMap'));

describe('PlaceSearchInput — lieux d’OpenStreetMap sur demande', () => {
  let rendered: RenderedComponent | null = null;

  beforeEach(() => {
    geocodePlaces.mockImplementation(async (_query: string, opts: GeocodeOptions) => (opts.includeLandmarks ? [GALIBIER, VALLOIRE] : [VALLOIRE]));
  });

  afterEach(() => {
    rendered?.unmount();
    rendered = null;
    geocodePlaces.mockReset();
  });

  it('cherche avec Mapbox seul à la frappe, puis ajoute OpenStreetMap au clic, avec l’attribution', async () => {
    rendered = renderComponent(createElement(PlaceSearchInput, { value: '', onPick: () => {}, debounceMs: 0 }));
    const input = rendered.container.querySelector('input')!;
    act(() => input.focus());
    typeInto(input, 'Galibier');
    await settle();

    expect(geocodePlaces).toHaveBeenLastCalledWith('Galibier', expect.objectContaining({ includeLandmarks: false }));
    expect(document.body.textContent).not.toContain('© les contributeurs OpenStreetMap');
    const row = landmarksRow();
    expect(row).toBeDefined();

    rendered.click(row!);
    await settle();

    expect(geocodePlaces).toHaveBeenLastCalledWith('Galibier', expect.objectContaining({ includeLandmarks: true }));
    expect(options()[0]?.textContent).toContain('Col du Galibier');
    expect(landmarksRow()).toBeUndefined();
    expect(document.body.textContent).toContain('Sommets, cols et sites : © les contributeurs OpenStreetMap');
  });

  it('se lance au clavier, et une nouvelle saisie revient à Mapbox seul', async () => {
    rendered = renderComponent(createElement(PlaceSearchInput, { value: '', onPick: () => {}, debounceMs: 0 }));
    const input = rendered.container.querySelector('input')!;
    act(() => input.focus());
    typeInto(input, 'Galibier');
    await settle();

    const key = (name: string) => act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
    key('ArrowDown'); // Valloire (0) → ligne OpenStreetMap (1)
    expect(landmarksRow()?.getAttribute('aria-selected')).toBe('true');
    key('Enter');
    await settle();
    expect(geocodePlaces).toHaveBeenLastCalledWith('Galibier', expect.objectContaining({ includeLandmarks: true }));

    typeInto(input, 'Galibier col');
    await settle();
    expect(geocodePlaces).toHaveBeenLastCalledWith('Galibier col', expect.objectContaining({ includeLandmarks: false }));
  });
});
