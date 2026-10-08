// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSummary } from '@/shared/services/projects';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Carte de projet : miniature du cloud avec repli sur la copie locale, qui
 * repart de zéro quand une nouvelle miniature arrive (l'URL locale
 * précédente est libérée), renommage suivant un renommage fait ailleurs, et
 * projet partagé par un autre propriétaire jamais renommé d'ici.
 */

const thumbnails = vi.hoisted(() => ({ local: null as Blob | null }));
vi.mock('@/shared/services/storage/idbProjectStore', () => ({ idbGetThumbnail: async () => thumbnails.local }));

const { ProjectCard } = await import('./ProjectCard');

let view: RenderedComponent | null = null;
const revoked: string[] = [];

function summary(name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: 'p1', folderId: null, name, privacy: 'private', sizeBytes: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra };
}

function element(project: ProjectSummary, thumbnailUrl: string | null, onRename = vi.fn()) {
  const noop = () => {};
  return createElement(ProjectCard, {
    project, view: 'grid', thumbnailUrl, thumbnailLoading: false, onOpen: noop, onRename, busy: false, dragActive: false,
    onOpenMenu: noop, onDragStart: noop, onDragMove: noop, onDragEnd: noop,
  });
}

const image = () => view!.container.querySelector<HTMLImageElement>('img.rvpb-card__preview-image');
const input = () => view!.container.querySelector<HTMLInputElement>('input.rvpb-card__rename-input');

async function fail(img: HTMLImageElement) {
  await act(async () => { img.dispatchEvent(new Event('error')); });
}

beforeEach(() => {
  thumbnails.local = null;
  revoked.length = 0;
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local-${++next}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url); });
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('ProjectCard : miniature', () => {
  it('miniature du cloud introuvable et pas de copie locale : repère, puis une nouvelle miniature est réessayée', async () => {
    view = renderComponent(element(summary('Tour'), 'https://cloud/thumb-1'));
    await fail(image()!);
    expect(image()).toBeNull();

    act(() => view!.rerender(element(summary('Tour'), 'https://cloud/thumb-2')));
    expect(image()?.getAttribute('src')).toBe('https://cloud/thumb-2');
  });

  it('repli sur la miniature locale ; l’URL locale est libérée quand une nouvelle miniature arrive', async () => {
    thumbnails.local = new Blob(['png']);
    view = renderComponent(element(summary('Tour'), 'https://cloud/thumb-1'));
    await fail(image()!);
    expect(image()?.getAttribute('src')).toBe('blob:local-1');

    act(() => view!.rerender(element(summary('Tour'), 'https://cloud/thumb-2')));
    expect(image()?.getAttribute('src')).toBe('https://cloud/thumb-2');
    expect(revoked).toEqual(['blob:local-1']);
  });
});

describe('ProjectCard : renommage', () => {
  function startRenaming() {
    act(() => { view!.container.querySelector('h3')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  }

  it('renommé ailleurs : le nouveau nom remplace le brouillon', () => {
    const onRename = vi.fn();
    view = renderComponent(element(summary('Tour'), null, onRename));
    act(() => view!.rerender(element(summary('Tour du Mont-Blanc'), null, onRename)));
    startRenaming();
    expect(input()?.value).toBe('Tour du Mont-Blanc');
  });

  it('projet partagé par un autre propriétaire : jamais renommé d’ici', () => {
    view = renderComponent(element(summary('Partagé', { shared: true, sharedWithMe: true }), null));
    startRenaming();
    expect(input()).toBeNull();
  });
});
