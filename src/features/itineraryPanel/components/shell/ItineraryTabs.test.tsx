// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import type { Itinerary, RouteProfile } from '../../types';
import { ItineraryTabs } from './ItineraryTabs';

/**
 * Liste des itinéraires du panneau : sélection (clic, clavier), œil qui
 * masque sans sélectionner, libellé du profil, menu d'actions limité aux
 * actions fournies, renommage en place, ligne d'import GPX en cours.
 */

const PROFILES = [{ id: 'road', name: 'Route' }, { id: 'gravel', name: 'Gravel' }] as unknown as RouteProfile[];

function itinerary(id: string, name: string, extra: Partial<Itinerary> = {}): Itinerary {
  return { id, name, color: '#c50000', visible: true, profileId: 'road', ...extra } as unknown as Itinerary;
}

const ITINERARIES = [
  itinerary('a', 'Col du Galibier'),
  itinerary('b', 'Variante gravel', { profileId: 'gravel', visible: false }),
  itinerary('c', 'Footing', { discipline: 'running', profileId: 'inconnu' } as Partial<Itinerary>),
  itinerary('d', 'Profil perdu', { profileId: 'inconnu' }),
];

type Props = Parameters<typeof ItineraryTabs>[0];

let view: RenderedComponent | null = null;

function render(props: Partial<Props> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onToggleVisibility: vi.fn(),
    onAdd: vi.fn(),
    onDuplicate: vi.fn(),
    onRemove: vi.fn(),
    onRename: vi.fn(),
  };
  view = renderComponent(createElement(ItineraryTabs, {
    itineraries: ITINERARIES,
    profiles: PROFILES,
    activeId: 'a',
    ...handlers,
    ...props,
  }));
  return { view, ...handlers };
}

function row(name: string): HTMLElement {
  const found = [...(view?.container.querySelectorAll<HTMLElement>('.rvi-itin[role="button"]') ?? [])]
    .find((candidate) => candidate.querySelector('.rvi-itin__label')?.textContent === name);
  if (!found) throw new Error(`ligne « ${name} » absente`);
  return found;
}

function menuItem(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(target: Element, keyName: string): void {
  act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true })));
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('ItineraryTabs', () => {
  it('affiche chaque itinéraire avec son profil, l\'actif marqué', () => {
    render();
    expect(row('Col du Galibier').getAttribute('aria-pressed')).toBe('true');
    expect(row('Variante gravel').getAttribute('aria-pressed')).toBe('false');
    const profileOf = (name: string) => row(name).querySelector('.rvi-itin__profile')?.textContent;
    expect(profileOf('Col du Galibier')).toBe('Route');
    expect(profileOf('Variante gravel')).toBe('Gravel');
    expect(profileOf('Footing')).toBe('Running');
    expect(profileOf('Profil perdu')).toBe('Personnalisé');
  });

  it('un clic ou Entrée sélectionne l\'itinéraire', () => {
    const { view, onSelect } = render();
    view.click(row('Variante gravel'));
    expect(onSelect).toHaveBeenLastCalledWith('b');
    key(row('Footing'), 'Enter');
    expect(onSelect).toHaveBeenLastCalledWith('c');
  });

  it('l\'œil masque ou affiche sans sélectionner', () => {
    const { view, onToggleVisibility, onSelect } = render();
    const hiddenEye = row('Variante gravel').querySelector<HTMLButtonElement>('.rvi-itin__eye')!;
    expect(hiddenEye.getAttribute('aria-label')).toMatch(/^Afficher l['’]itinéraire$/);
    view.click(hiddenEye);
    expect(onToggleVisibility).toHaveBeenCalledWith('b');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('le menu d\'actions duplique et supprime l\'itinéraire visé, puis se ferme', () => {
    const { view, onDuplicate, onRemove } = render();
    const trigger = view.button('Actions pour Variante gravel');
    view.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    view.click(menuItem('Dupliquer')!);
    expect(onDuplicate).toHaveBeenCalledWith('b');
    expect(menuItem('Dupliquer')).toBeNull();

    view.click(view.button('Actions pour Footing'));
    view.click(menuItem('Supprimer')!);
    expect(onRemove).toHaveBeenCalledWith('c');
  });

  it('le menu ne propose que les actions fournies, et disparaît sans aucune', () => {
    const { view } = render({ onDuplicate: undefined, onRemove: undefined });
    view.click(view.button('Actions pour Col du Galibier'));
    expect(menuItem('Renommer')).not.toBeNull();
    expect(menuItem('Dupliquer')).toBeNull();
    expect(menuItem('Supprimer')).toBeNull();
    view.unmount();

    render({ onDuplicate: undefined, onRemove: undefined, onRename: undefined });
    expect(view?.container.querySelector('.rvi-itin__menu-trigger')).toBeNull();
  });

  it('renommer : Entrée valide le nom sans espaces, Échap annule, un nom vide est ignoré', () => {
    const { view, onRename } = render();
    view.click(view.button('Actions pour Col du Galibier'));
    view.click(menuItem('Renommer')!);
    let input = view.container.querySelector<HTMLInputElement>('input[aria-label="Renommer Col du Galibier"]')!;
    expect(input.value).toBe('Col du Galibier');
    typeInto(input, '  Galibier par Valloire  ');
    key(input, 'Enter');
    expect(onRename).toHaveBeenCalledWith('a', 'Galibier par Valloire');

    view.click(view.button('Actions pour Footing'));
    view.click(menuItem('Renommer')!);
    input = view.container.querySelector<HTMLInputElement>('input[aria-label="Renommer Footing"]')!;
    typeInto(input, 'Autre nom');
    key(input, 'Escape');
    expect(view.container.querySelector('input')).toBeNull();
    expect(onRename).toHaveBeenCalledTimes(1);

    view.click(view.button('Actions pour Footing'));
    view.click(menuItem('Renommer')!);
    input = view.container.querySelector<HTMLInputElement>('input[aria-label="Renommer Footing"]')!;
    typeInto(input, '   ');
    key(input, 'Enter');
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('pendant un import GPX, une ligne « Chargement… » précède « Nouvel itinéraire »', () => {
    const { view, onAdd } = render({ pendingImportName: 'GT20.gpx' });
    const pending = view.container.querySelector('.rvi-itin--pending');
    expect(pending?.textContent).toContain('GT20.gpx');
    expect(pending?.textContent).toContain('Chargement…');
    view.click(view.button('Nouvel itinéraire'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
