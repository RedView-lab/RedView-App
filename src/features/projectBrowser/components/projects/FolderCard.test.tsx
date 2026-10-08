// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectFolderSummary } from '@/shared/services/projects';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { FolderCard } from './FolderCard';

/**
 * Renommage d'un dossier en place : double-clic, Entrée valide (nom
 * nettoyé), Échap ou nom vide annulent, et un renommage fait ailleurs
 * (autre onglet, rechargement de la liste) remplace le brouillon.
 */

const folder = (name: string): ProjectFolderSummary => ({
  id: 'f1', parentFolderId: null, name, privacy: 'private', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});

let view: RenderedComponent | null = null;

function element(name: string, onRename: (id: string, name: string) => void) {
  const noop = () => {};
  return createElement(FolderCard, {
    folder: folder(name), view: 'grid', sizeBytes: 0, busy: false, dragActive: false, dropActive: false,
    onOpen: noop, onRename, onOpenMenu: noop, onDragStart: noop, onDragMove: noop, onDragEnd: noop,
    onDragEnterTarget: noop, onDragLeaveTarget: noop, onDropIntoFolder: noop,
  });
}

function render(name: string, onRename = vi.fn()) {
  view = renderComponent(element(name, onRename));
  return { view, onRename };
}

const input = () => view!.container.querySelector<HTMLInputElement>('input.rvpb-card__rename-input');

function startRenaming() {
  act(() => { view!.container.querySelector('h3')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
}

function type(value: string) {
  const field = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(name: string) {
  act(() => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('FolderCard : renommage', () => {
  it('Entrée enregistre le nom nettoyé', async () => {
    const { onRename } = render('Alpes');
    startRenaming();
    expect(input()?.value).toBe('Alpes');
    type('  Pyrénées  ');
    await act(async () => { key('Enter'); });
    expect(onRename).toHaveBeenCalledWith('f1', 'Pyrénées');
  });

  it('Échap annule et rend le nom courant', () => {
    const { onRename } = render('Alpes');
    startRenaming();
    type('Brouillon');
    key('Escape');
    expect(input()).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
    startRenaming();
    expect(input()?.value).toBe('Alpes');
  });

  it('nom vide ou inchangé : rien n’est envoyé', async () => {
    const { onRename } = render('Alpes');
    startRenaming();
    type('   ');
    await act(async () => { key('Enter'); });
    startRenaming();
    await act(async () => { key('Enter'); });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('renommé ailleurs : le nouveau nom remplace le brouillon', () => {
    const onRename = vi.fn();
    render('Alpes', onRename);
    act(() => view!.rerender(element('Alpes du Nord', onRename)));
    startRenaming();
    expect(input()?.value).toBe('Alpes du Nord');
  });
});
