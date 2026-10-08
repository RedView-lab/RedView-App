// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_POI_OPTIONS } from '@/pages/Dashboard/components/DashboardPlaceSearch.constants';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { TimelineFilterBar } from './TimelineFilterBar';
import { DEFAULT_TIMELINE_FILTER, type TimelineFilterState } from './TimelineFilters';

/**
 * Barre de filtres de la feuille de route (tableau et agenda) : état
 * synchronisé ou modifié localement, chips qui basculent un type de ligne,
 * menu des catégories de POI (toutes ↔ aucune ↔ sous-ensemble) et sa
 * fermeture au clic extérieur ou à Échap.
 */

let view: RenderedComponent | null = null;

function render(filters: TimelineFilterState, props: { isOverridden?: boolean; onResetToGlobal?: () => void } = {}) {
  const onChangeFilters = vi.fn<(next: TimelineFilterState) => void>();
  const element = createElement(TimelineFilterBar, {
    filters,
    isOverridden: props.isOverridden ?? false,
    onChangeFilters,
    onResetToGlobal: props.onResetToGlobal,
    title: 'Filtres du tableau',
    ariaLabel: 'Filtres de la feuille de route',
  });
  view = renderComponent(element);
  return { view, onChangeFilters };
}

function chip(label: string): HTMLButtonElement {
  const found = [...(view?.container.querySelectorAll<HTMLButtonElement>('.rvi-tl-sheet-filters__chip') ?? [])]
    .find((candidate) => candidate.querySelector('.rvi-tl-sheet-filters__chip-label')?.textContent?.startsWith(label));
  if (!found) throw new Error(`chip « ${label} » absent`);
  return found;
}

function menu(): HTMLElement | null {
  return view?.container.querySelector<HTMLElement>('[role="menu"]') ?? null;
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`entrée « ${label} » absente`);
  return found;
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('TimelineFilterBar', () => {
  it('sans override, indique « Synchronisé » et n\'offre pas de réinitialisation', () => {
    const { view } = render(DEFAULT_TIMELINE_FILTER);
    expect(view.container.textContent).toContain('Synchronisé');
    expect(view.container.textContent).not.toContain('Réinitialiser');
  });

  it('avec override, « Réinitialiser » revient aux filtres globaux', () => {
    const onResetToGlobal = vi.fn();
    const { view } = render({ ...DEFAULT_TIMELINE_FILTER, pause: false }, { isOverridden: true, onResetToGlobal });
    expect(view.container.textContent).not.toContain('Synchronisé');
    view.click(view.button('Réinitialiser'));
    expect(onResetToGlobal).toHaveBeenCalledTimes(1);
  });

  it('chaque chip bascule son seul type de ligne et reflète son état', () => {
    const filters: TimelineFilterState = { ...DEFAULT_TIMELINE_FILTER, favorite: false };
    const { view, onChangeFilters } = render(filters);
    expect(chip('Favoris').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Pauses').getAttribute('aria-pressed')).toBe('true');

    view.click(chip('Favoris'));
    expect(onChangeFilters).toHaveBeenLastCalledWith({ ...filters, favorite: true });
    view.click(chip('Pauses'));
    expect(onChangeFilters).toHaveBeenLastCalledWith({ ...filters, pause: false });
    view.click(chip('Points de passage'));
    expect(onChangeFilters).toHaveBeenLastCalledWith({ ...filters, waypoint: false });
    view.click(chip('Étape'));
    expect(onChangeFilters).toHaveBeenLastCalledWith({ ...filters, etape: false });
    view.click(chip('POIs'));
    expect(onChangeFilters).toHaveBeenLastCalledWith({ ...filters, poi: false });
  });

  it('menu des catégories : décocher une catégorie garde toutes les autres', () => {
    const { view, onChangeFilters } = render(DEFAULT_TIMELINE_FILTER);
    view.click(view.button('Catégories POI'));
    expect(menu()).not.toBeNull();
    expect(menuItem('Toutes les catégories').getAttribute('aria-checked')).toBe('true');

    view.click(menuItem('Eau'));
    const next = onChangeFilters.mock.lastCall?.[0];
    expect(next?.categories?.has('drinking_water')).toBe(false);
    expect(next?.categories?.size).toBe(DASHBOARD_POI_OPTIONS.length - 1);
  });

  it('menu des catégories : « Toutes » décoche tout, puis recoche tout (ensemble vide = aucune, absent = toutes)', () => {
    const { view, onChangeFilters } = render(DEFAULT_TIMELINE_FILTER);
    view.click(view.button('Catégories POI'));
    view.click(menuItem('Toutes les catégories'));
    expect(onChangeFilters.mock.lastCall?.[0].categories?.size).toBe(0);

    view.rerender(createElement(TimelineFilterBar, {
      filters: { ...DEFAULT_TIMELINE_FILTER, categories: new Set(['bakery']) },
      isOverridden: true,
      onChangeFilters,
      title: 'Filtres du tableau',
      ariaLabel: 'Filtres de la feuille de route',
    }));
    expect(chip('POIs').textContent).toContain('(1)');
    expect(menuItem('Toutes les catégories').getAttribute('aria-checked')).toBe('false');
    view.click(menuItem('Toutes les catégories'));
    expect(onChangeFilters.mock.lastCall?.[0].categories).toBeUndefined();
  });

  it('recocher la dernière catégorie manquante revient à « toutes » (ensemble absent)', () => {
    const allButOne = new Set(DASHBOARD_POI_OPTIONS.map((option) => option.id).filter((id) => id !== 'bar'));
    const { view, onChangeFilters } = render({ ...DEFAULT_TIMELINE_FILTER, categories: allButOne });
    view.click(view.button('Catégories POI'));
    view.click(menuItem('Bar'));
    expect(onChangeFilters.mock.lastCall?.[0].categories).toBeUndefined();
  });

  it('le menu se ferme à Échap et au clic hors de lui, pas au clic dedans', () => {
    const { view } = render(DEFAULT_TIMELINE_FILTER);
    const trigger = view.button('Catégories POI');
    view.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => menu()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(menu()).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(menu()).toBeNull();

    view.click(trigger);
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(menu()).toBeNull();
  });
});
