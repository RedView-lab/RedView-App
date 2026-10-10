// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

import { createDefaultItinerary } from '../lib/project/defaultState';
import type { PoiState } from '../types';
import { PoiSection } from './PoiSection';

let rendered: RenderedComponent | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function distanceInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="Distance ${label}"]`);
  if (!input) throw new Error(`champ de distance « ${label} » absent`);
  return input;
}

describe('PoiSection : ligne Cimetières', () => {
  it('est affichée juste après les fontaines, cochée à 100 m par défaut', () => {
    rendered = renderComponent(createElement(PoiSection, { poi: createDefaultItinerary().poi }));
    const labels = [...rendered.container.querySelectorAll('.rvi-cfield__label')].map((el) => el.textContent);
    expect(labels.slice(0, 2)).toEqual(['Fontaines', 'Cimetières']);
    expect(distanceInput(rendered.container, 'Cimetières').value).toBe('100m');
    expect(rendered.container.querySelector<HTMLInputElement>('input[aria-label="Cimetières"]')?.checked).toBe(true);
  });

  it('recochée sans distance, elle reprend son propre défaut (100 m, pas 20 m)', () => {
    const onChangeEntry = vi.fn();
    const poi = { ...createDefaultItinerary().poi, cemeteries: { enabled: false, distanceM: null } } as PoiState;
    rendered = renderComponent(createElement(PoiSection, { poi, onChangeEntry }));
    expect(distanceInput(rendered.container, 'Cimetières').placeholder).toBe('100m');
    const checkbox = rendered.container.querySelector<HTMLInputElement>('input[aria-label="Cimetières"]')!;
    act(() => { checkbox.click(); });
    expect(onChangeEntry).toHaveBeenCalledWith('cemeteries', { enabled: true, distanceM: 100 });
  });
});
