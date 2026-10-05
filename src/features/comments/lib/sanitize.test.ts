import { describe, expect, it } from 'vitest';

import { sanitizeCommentThreads } from './sanitize';

const valid = {
  id: 'cm-1',
  anchor: { lng: 6.87, lat: 45.92, elevationM: 1035 },
  createdBy: 'u-1',
  createdAt: '2026-10-05T10:00:00.000Z',
  camera: { zoom: 13, pitch: 60, bearing: 10 },
  messages: [
    { id: 'm1', authorId: 'u-1', authorName: 'Alice', text: 'Col fermé', createdAt: '2026-10-05T10:00:00.000Z', reactions: { '👍~u-2': true } },
  ],
};

describe('fils venus d’un tiers', () => {
  it('garde un fil valable tel quel', () => {
    expect(sanitizeCommentThreads([valid])).toEqual([valid]);
  });

  it('écarte les fils et messages invalides, retire les champs facultatifs invalides', () => {
    const result = sanitizeCommentThreads([
      valid,
      { ...valid, id: 'cm-1' },
      { ...valid, id: 'cm-2', anchor: { lng: 500, lat: 0 } },
      { ...valid, id: 'cm-3', messages: [{ id: 'm', authorId: 'u', text: '', createdAt: 't' }] },
      { ...valid, id: 'cm-4', zone: { ring: [[0, 0]] }, camera: { zoom: 'x' }, messages: [...valid.messages, null, { ...valid.messages[0] }] },
      'texte',
    ])!;
    expect(result.map((thread) => thread.id)).toEqual(['cm-1', 'cm-4']);
    expect(result[1].zone).toBeUndefined();
    expect(result[1].camera).toBeUndefined();
    expect(result[1].messages).toHaveLength(1);
  });

  it('rien de valable : undefined', () => {
    expect(sanitizeCommentThreads([])).toBeUndefined();
    expect(sanitizeCommentThreads({})).toBeUndefined();
  });
});
