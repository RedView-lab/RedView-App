// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nContext, type AppI18nContextValue } from '@/shared/i18n/appI18nContext';
import { ProjectCloudError } from '@/shared/services/projects/errors';
import { setProjectSyncStatus } from '@/shared/services/projects/syncStatus';
import { renderHook, type RenderedHook } from '@/shared/test/renderHook';
import type { ItineraryProject } from '../../types';
import { useProjectSave } from './useProjectSave';

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/shared/lib/notify', () => ({ notify: toast }));
const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn<(options: { title: string }) => Promise<boolean>>() }));
vi.mock('@/shared/lib/appDialog', () => dialogs);

/**
 * Bouton Enregistrer et Ctrl/Cmd+S : une seule sauvegarde à la fois,
 * écrasement du cloud seulement sur confirmation après un conflit, statut
 * affiché (résultat du bouton, sinon état de l'autosave du projet affiché).
 */

const i18n = { locale: 'fr', setLocale: () => {}, t: (text: string) => text, bundle: {} } as unknown as AppI18nContextValue;
const wrapper = ({ children }: { children: ReactNode }) => createElement(AppI18nContext.Provider, { value: i18n }, children);

type Props = Parameters<typeof useProjectSave>[0];
type Save = NonNullable<Props['onSaveProject']>;

let hook: RenderedHook<Props, ReturnType<typeof useProjectSave>> | null = null;

function render(onSaveProject: Save | undefined, projectId = 'p1') {
  const setProject = vi.fn();
  hook = renderHook(useProjectSave, { initialProps: { projectId, onSaveProject, setProject }, wrapper });
  return { setProject, hook };
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  act(() => { window.dispatchEvent(event); });
  return event;
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const saved = { savedAt: '2026-10-08T10:00:00.000Z', sizeBytes: 1234 } as ItineraryProject;

beforeEach(() => {
  setProjectSyncStatus({ projectId: null, state: 'idle' });
  toast.error.mockReset();
  dialogs.confirmDialog.mockReset();
});

afterEach(() => {
  hook?.unmount();
  hook = null;
  vi.useRealTimers();
});

describe('raccourci clavier', () => {
  it('Ctrl+S et Cmd+S enregistrent et empêchent la sauvegarde de page du navigateur', async () => {
    const save = vi.fn<Save>(async () => saved);
    render(save);
    const ctrl = press({ key: 's', ctrlKey: true });
    await settle();
    expect(ctrl.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    press({ key: 'S', metaKey: true });
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('ni « s » seul, ni Ctrl+Alt+S, ni une autre touche', async () => {
    const save = vi.fn<Save>(async () => saved);
    render(save);
    expect(press({ key: 's' }).defaultPrevented).toBe(false);
    expect(press({ key: 's', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: 'd', ctrlKey: true }).defaultPrevented).toBe(false);
    await settle();
    expect(save).not.toHaveBeenCalled();
  });

  it('sans sauvegarde possible, Ctrl+S est laissé au navigateur', () => {
    render(undefined);
    expect(press({ key: 's', ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('une seule sauvegarde à la fois', async () => {
    let finish: (value: ItineraryProject) => void = () => {};
    const save = vi.fn<Save>(() => new Promise((resolve) => { finish = resolve; }));
    const { hook } = render(save);
    press({ key: 's', ctrlKey: true });
    await settle();
    expect(hook.result.current.displayedSaveStatus).toBe('saving');
    press({ key: 's', ctrlKey: true });
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(saved); });
    expect(hook.result.current.displayedSaveStatus).toBe('saved');
  });
});

describe('résultat d’une sauvegarde', () => {
  it('reporte la date et la taille enregistrées, puis revient à l’état de repos après 2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { setProject, hook } = render(vi.fn<Save>(async () => saved));
    await act(async () => { await hook.result.current.handleSaveProject(); });
    expect(hook.result.current.displayedSaveStatus).toBe('saved');
    const update = setProject.mock.calls[0]![0] as (prev: ItineraryProject) => ItineraryProject;
    expect(update({ name: 'P' } as ItineraryProject)).toEqual({ name: 'P', savedAt: saved.savedAt, sizeBytes: saved.sizeBytes });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(hook.result.current.displayedSaveStatus).toBe('idle');
  });

  it('conflit : écrase le cloud seulement si l’utilisateur confirme', async () => {
    dialogs.confirmDialog.mockResolvedValue(true);
    const save = vi.fn<Save>(async (options) => {
      if (!options?.force) throw new ProjectCloudError('conflict');
      return saved;
    });
    const { hook } = render(save);
    await act(async () => { await hook.result.current.handleSaveProject(); });
    expect(dialogs.confirmDialog).toHaveBeenCalledTimes(1);
    expect(dialogs.confirmDialog.mock.calls[0]![0].title).toBe('Ce projet a été modifié sur un autre appareil');
    expect(save).toHaveBeenLastCalledWith({ force: true });
    expect(hook.result.current.displayedSaveStatus).toBe('saved');
  });

  it('conflit refusé : rien n’est écrasé, l’erreur est affichée 6 s', async () => {
    dialogs.confirmDialog.mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const save = vi.fn<Save>(async () => { throw new ProjectCloudError('conflict'); });
    const { hook } = render(save);
    await act(async () => { await hook.result.current.handleSaveProject(); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(hook.result.current.displayedSaveStatus).toBe('error');
    expect(hook.result.current.displayedSaveMessage).toBe(new ProjectCloudError('conflict').message);
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(hook.result.current.displayedSaveStatus).toBe('error');
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.result.current.displayedSaveStatus).toBe('idle');
  });

  it('une autre erreur ne demande aucune confirmation', async () => {
    dialogs.confirmDialog.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = vi.fn<Save>(async () => { throw new ProjectCloudError('offline'); });
    const { hook } = render(offline);
    await act(async () => { await hook.result.current.handleSaveProject(); });
    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(offline).toHaveBeenCalledTimes(1);
    expect(hook.result.current.displayedSaveMessage).toBe(new ProjectCloudError('offline').message);
    hook.unmount();

    const { hook: other } = render(vi.fn<Save>(async () => { throw new Error('boom'); }));
    await act(async () => { await other.result.current.handleSaveProject(); });
    expect(other.result.current.displayedSaveMessage).toBe('Échec de l’enregistrement');
  });
});

describe('statut affiché au repos', () => {
  it('reprend l’état de l’autosave du projet affiché, jamais celui d’un autre projet', () => {
    const { hook } = render(vi.fn<Save>(async () => saved), 'p1');
    act(() => setProjectSyncStatus({ projectId: 'p1', state: 'pending-offline', message: 'Hors ligne' }));
    expect(hook.result.current.displayedSaveStatus).toBe('pending');
    expect(hook.result.current.displayedSaveMessage).toBe('Hors ligne');
    act(() => setProjectSyncStatus({ projectId: 'p1', state: 'error', message: 'Refusé' }));
    expect(hook.result.current.displayedSaveStatus).toBe('error');
    act(() => setProjectSyncStatus({ projectId: 'p2', state: 'error', message: 'Autre projet' }));
    expect(hook.result.current.displayedSaveStatus).toBe('idle');
    expect(hook.result.current.displayedSaveMessage).toBeNull();
  });
});

describe('copie locale impossible (stockage plein)', () => {
  it('un toast par épisode, seulement pour le projet affiché', () => {
    render(undefined);
    const lost = { state: 'error' as const, errorKind: 'offline' as const, message: 'Stockage du navigateur plein : …', localCopyLost: true };
    act(() => setProjectSyncStatus({ projectId: 'autre', ...lost }));
    expect(toast.error).not.toHaveBeenCalled();

    act(() => setProjectSyncStatus({ projectId: 'p1', ...lost }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Stockage du navigateur plein : …');
    // nouvel essai, toujours perdu : pas de second toast
    act(() => setProjectSyncStatus({ projectId: 'p1', ...lost, errorKind: 'rejected' }));
    expect(toast.error).toHaveBeenCalledTimes(1);

    act(() => setProjectSyncStatus({ projectId: 'p1', state: 'saved' }));
    act(() => setProjectSyncStatus({ projectId: 'p1', ...lost }));
    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});
