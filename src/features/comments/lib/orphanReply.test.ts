// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

import { DeletedThreadCard } from '../components/CommentThreadCard';
import { orphanedReply, ReplyDrafts } from './orphanReply';

/** Fil supprimé par son auteur pendant qu'un autre éditeur y répond (E3-1). */

const thread = (id: string, createdBy: string) => ({
  id,
  anchor: { lng: 6.4, lat: 45.5 },
  createdBy,
  createdAt: '2026-10-10T10:00:00.000Z',
  messages: [{ id: 'm1', authorId: createdBy, authorName: 'A', text: 'Couloir', createdAt: '2026-10-10T10:00:00.000Z' }],
}) as unknown as ProjectCommentThread;

let rendered: RenderedComponent | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

describe('réponse dont le fil a été supprimé', () => {
  const byAlice = thread('t1', 'alice');

  it('gardée quand le fil d’un autre disparaît pendant la saisie', () => {
    expect(orphanedReply(byAlice, null, [], 'bob', '  Longue réponse  ')).toBe('Longue réponse');
  });

  it('rien à garder : fil toujours là (simplement fermé), le sien supprimé, ou rien de saisi', () => {
    expect(orphanedReply(byAlice, null, [byAlice], 'bob', 'texte')).toBeNull();
    expect(orphanedReply(byAlice, null, [], 'alice', 'texte')).toBeNull();
    expect(orphanedReply(byAlice, null, [], 'bob', '   ')).toBeNull();
    expect(orphanedReply(byAlice, thread('t2', 'carol'), [], 'bob', 'texte')).toBeNull();
  });

  it('la carte montre le texte non envoyé et le copie', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onClose = vi.fn();
    rendered = renderComponent(createElement(DeletedThreadCard, { text: 'Longue réponse', onClose }));
    expect(rendered.container.textContent).toContain('Longue réponse');
    rendered.click(rendered.button('Copier le texte'));
    expect(writeText).toHaveBeenCalledWith('Longue réponse');
    rendered.click(rendered.button('Fermer'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReplyDrafts', () => {
  it('garde la réponse de chaque fil, écrite par le composeur, retrouvée à la réouverture', () => {
    const drafts = new ReplyDrafts();
    const binding = drafts.binding('t1');
    binding.current = 'En cours';
    expect(drafts.text('t1')).toBe('En cours');
    expect(drafts.binding('t1').current).toBe('En cours');
    expect(drafts.text('t2')).toBe('');
    // Réponse envoyée : le composeur se vide, le brouillon aussi.
    binding.current = '';
    expect(drafts.text('t1')).toBe('');
    drafts.binding('t1').current = 'Autre';
    expect(drafts.take('t1')).toBe('Autre');
    expect(drafts.text('t1')).toBe('');
  });
});
