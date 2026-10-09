// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { CommentMessage } from './CommentMessage';

/**
 * Menu « Plus d'actions » d'un message : Modifier / Supprimer sur les siens,
 * « Signaler » (e-mail prérempli, DSA art. 16) sur ceux des autres.
 */

const message = { id: 'msg_1', authorId: 'u_other', authorName: 'Ada', text: 'Un commentaire', createdAt: '2026-10-09T10:00:00.000Z' };

function render(canEdit: boolean): RenderedComponent {
  return renderComponent(createElement(CommentMessage, {
    message,
    authorName: 'Ada',
    meId: canEdit ? 'u_other' : 'u_me',
    members: [],
    candidates: [],
    now: Date.parse('2026-10-09T11:00:00.000Z'),
    deletesThread: false,
    canEdit,
    onEdit: () => true,
    onDelete: () => {},
    onToggleReaction: () => {},
  }));
}

const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')];

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

describe('CommentMessage — menu', () => {
  it('sur le message de quelqu’un d’autre : « Signaler », un e-mail prérempli à l’adresse de contact', () => {
    view = render(false);
    view.click(view.button('Plus d’actions'));
    const items = menuItems();
    expect(items.map((item) => item.textContent)).toEqual(['Signaler']);
    const href = (items[0] as HTMLAnchorElement).getAttribute('href') ?? '';
    expect(href.startsWith('mailto:redview.app@proton.me?subject=')).toBe(true);
    expect(decodeURIComponent(href)).toContain('Identifiant du message : msg_1');
  });

  it('sur son propre message : Modifier et Supprimer, pas de signalement', () => {
    view = render(true);
    view.click(view.button('Plus d’actions'));
    expect(menuItems().map((item) => item.textContent)).toEqual(['Modifier', 'Supprimer']);
  });
});
