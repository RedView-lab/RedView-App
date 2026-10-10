// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { createDefaultItinerary, createDefaultProject } from '../../lib/project/defaultState';
import type { ItineraryProject } from '../../types';
import { useProjectStore } from './hooks';
import { ProjectProvider } from './provider';
import type { ProjectStoreValue } from './types';

/**
 * Un ProjectProvider démonté (projet quitté) ne publie plus rien : un résultat
 * async qui arrive après (import GPX, revêtements, toponymes…) ne doit jamais
 * repartir vers le Dashboard, qui l'enregistrerait sous le projet ouvert
 * ensuite (B1-1).
 */

function project(name: string): ItineraryProject {
  const itinerary = createDefaultItinerary(1);
  return { ...createDefaultProject(), name, itineraries: [itinerary], activeItineraryId: itinerary.id };
}

let rendered: RenderedComponent | null = null;

afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});

function mount(initial: ItineraryProject, onProjectChange: (next: ItineraryProject) => void) {
  let store: ProjectStoreValue | null = null;
  function Probe(): ReactNode {
    store = useProjectStore();
    return null;
  }
  rendered = renderComponent(createElement(ProjectProvider, { initialProject: initial, onProjectChange, children: createElement(Probe) }));
  return () => store!;
}

describe('ProjectProvider démonté', () => {
  it('une écriture tardive (résultat async) ne publie plus rien', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onProjectChange = vi.fn();
    const store = mount(project('A'), onProjectChange);
    const { setProject, setProjectWithoutHistory, commitComments } = store();

    store().setProject((current) => ({ ...current, name: 'A modifié' }));
    expect(onProjectChange).toHaveBeenCalledTimes(1);

    rendered!.unmount();
    rendered = null;
    onProjectChange.mockClear();

    setProject((current) => ({ ...current, name: 'A + import GPX' }));
    setProjectWithoutHistory((current) => ({ ...current, name: 'A + revêtements' }));
    commitComments(() => [{ id: 'c1' } as never]);
    expect(onProjectChange).not.toHaveBeenCalled();
  });
});
