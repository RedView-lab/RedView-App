// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectStoreContext } from '@/features/itineraryPanel/context/ProjectStore/context';
import type { ProjectStoreValue } from '@/features/itineraryPanel/context/ProjectStore/types';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { AnalysisFlyoverContext } from '../../flyover/context';
import type { AnalysisFlyoverContextValue } from '../../flyover/types';
import { CenterPanelToolbar } from './CenterPanelToolbar';

/**
 * Barre d'outils du panneau central : quels boutons sont actifs selon
 * l'itinéraire actif et le store, ce que déclenchent Supprimer, Inverser,
 * Annuler/Rétablir et la lecture du flyover, et le message d'état.
 */

type ItineraryShape = Partial<Itinerary> & { id: string };

function itinerary(id: string, pointCount: number): ItineraryShape {
  return {
    id,
    timeline: [],
    gpxRoute: pointCount > 0
      ? { name: null, points: Array.from({ length: pointCount }, (_, i) => ({ lat: 45 + i * 0.001, lon: 6 + i * 0.001 })) } as unknown as NonNullable<Itinerary['gpxRoute']>
      : undefined,
  };
}

function fakeStore(
  itineraries: ItineraryShape[],
  activeItineraryId: string | null,
  overrides: Partial<ProjectStoreValue> = {},
): ProjectStoreValue {
  return {
    project: { itineraries, activeItineraryId },
    canUndoTraceEdit: false,
    canRedoTraceEdit: false,
    undoTraceEdit: vi.fn(),
    redoTraceEdit: vi.fn(),
    clearItineraryRoute: vi.fn(),
    reverseItineraryGpx: vi.fn(() => true),
    ...overrides,
  } as unknown as ProjectStoreValue;
}

function flyover(overrides: Partial<AnalysisFlyoverContextValue> = {}): AnalysisFlyoverContextValue {
  return {
    canPlay: false,
    isPlaying: false,
    playbackActive: false,
    togglePlayback: vi.fn(),
    slowDown: vi.fn(),
    speedUp: vi.fn(),
    resetPlayback: vi.fn(),
    canSlowDown: true,
    canSpeedUp: true,
    distanceLabel: '0 km',
    timeLabel: '0:00',
    ...overrides,
  };
}

let view: RenderedComponent | null = null;

function render(store: ProjectStoreValue, flyoverValue: AnalysisFlyoverContextValue, props: { isPanelVisible?: boolean; onTogglePanel?: () => void } = {}) {
  const tree = createElement(
    ProjectStoreContext.Provider,
    { value: store },
    createElement(AnalysisFlyoverContext.Provider, { value: flyoverValue }, createElement(CenterPanelToolbar, props)),
  );
  if (view) view.rerender(tree);
  else view = renderComponent(tree);
  return view.container;
}

function button(label: string): HTMLButtonElement {
  const found = view?.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`bouton « ${label} » absent`);
  return found;
}

function click(target: HTMLElement): void {
  view?.click(target);
}

function statusText(): string | null {
  return view?.container.querySelector('[role="status"]')?.textContent ?? null;
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('CenterPanelToolbar', () => {
  it('sans trace, les outils d\'édition et la lecture sont désactivés', () => {
    render(fakeStore([itinerary('a', 0)], 'a'), flyover());
    for (const label of ['Inverser', 'Supprimer', 'Annuler la modification', 'Rétablir', 'Ajouter', 'Tracer']) {
      expect(button(label).disabled, label).toBe(true);
    }
    expect(button('Lancer le flyover').disabled).toBe(true);
  });

  it('Supprimer efface la trace de l\'itinéraire actif et l\'annonce', () => {
    const store = fakeStore([itinerary('a', 3), itinerary('b', 3)], 'b');
    render(store, flyover());
    const remove = button('Supprimer');
    expect(remove.disabled).toBe(false);
    click(remove);
    expect(store.clearItineraryRoute).toHaveBeenCalledWith('b');
    expect(statusText()).toBe('Trace supprimée');
  });

  it('Inverser dit si l\'inversion a eu lieu', () => {
    const ok = fakeStore([itinerary('a', 3)], 'a');
    render(ok, flyover());
    click(button('Inverser'));
    expect(ok.reverseItineraryGpx).toHaveBeenCalledWith('a');
    expect(statusText()).toBe('Sens du GPX inversé');

    const refused = fakeStore([itinerary('a', 3)], 'a', { reverseItineraryGpx: vi.fn(() => false) });
    render(refused, flyover());
    click(button('Inverser'));
    expect(statusText()).toBe('Inversion indisponible pour cette trace');
  });

  it('une seule position ne s\'inverse pas', () => {
    render(fakeStore([itinerary('a', 1)], 'a'), flyover());
    expect(button('Inverser').disabled).toBe(true);
  });

  it('Annuler et Rétablir suivent l\'historique du store', () => {
    const store = fakeStore([itinerary('a', 3)], 'a', { canUndoTraceEdit: true, canRedoTraceEdit: false });
    render(store, flyover());
    expect(button('Rétablir').disabled).toBe(true);
    click(button('Annuler la modification'));
    expect(store.undoTraceEdit).toHaveBeenCalledTimes(1);
    expect(store.redoTraceEdit).not.toHaveBeenCalled();
  });

  it('le message d\'état s\'efface quand l\'itinéraire actif change', () => {
    const routes = [itinerary('a', 3), itinerary('b', 3)];
    const store = fakeStore(routes, 'a');
    render(store, flyover());
    click(button('Supprimer'));
    expect(statusText()).toBe('Trace supprimée');
    render(fakeStore(routes, 'b'), flyover());
    expect(statusText()).toBeNull();
  });

  it('le bouton de lecture suit l\'état du flyover', () => {
    const paused = flyover({ canPlay: true });
    render(fakeStore([itinerary('a', 3)], 'a'), paused);
    const play = button('Lancer le flyover');
    expect(play.getAttribute('aria-pressed')).toBe('false');
    click(play);
    expect(paused.togglePlayback).toHaveBeenCalledTimes(1);

    render(fakeStore([itinerary('a', 3)], 'a'), flyover({ canPlay: true, isPlaying: true }));
    expect(button('Mettre en pause le flyover').getAttribute('aria-pressed')).toBe('true');
  });

  it('le bouton du panneau central n\'apparaît qu\'avec onTogglePanel et reflète sa visibilité', () => {
    render(fakeStore([itinerary('a', 3)], 'a'), flyover());
    expect(view?.container.querySelector('button[aria-label="Masquer le panneau central"]')).toBeNull();

    const onTogglePanel = vi.fn();
    render(fakeStore([itinerary('a', 3)], 'a'), flyover(), { isPanelVisible: false, onTogglePanel });
    const toggle = button('Afficher le panneau central');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    expect(onTogglePanel).toHaveBeenCalledTimes(1);
  });
});
