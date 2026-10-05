import { describe, expect, it } from 'vitest';

import { readLidarCommentState } from './lidarCommentChannel';

const thread = {
  id: 'cm-1',
  anchor: { lng: 6.4, lat: 45.54, elevationM: 2400 },
  createdBy: 'u-1',
  createdAt: '2026-10-05T10:00:00.000Z',
  messages: [{ id: 'm-1', authorId: 'u-1', authorName: 'Alice', text: 'Couloir', createdAt: '2026-10-05T10:00:00.000Z' }],
};

describe('pont des commentaires vers le viewer LiDAR', () => {
  it('lit un état valable, fils vérifiés', () => {
    const state = readLidarCommentState({
      version: 1, type: 'STATE', projectId: 'p-1', updatedAt: 't', me: { userId: 'u-1', name: 'Alice' },
      members: [{ userId: 'u-2', name: 'Bob' }, { userId: 3 }], threads: [thread, { id: 'cassé' }], reads: { 'cm-1': { m: 'm-1' } },
    });
    expect(state?.threads.map((t) => t.id)).toEqual(['cm-1']);
    expect(state?.members).toEqual([{ userId: 'u-2', name: 'Bob' }]);
    expect(state?.reads).toEqual({ 'cm-1': { m: 'm-1' } });
  });

  it('refuse un message qui n’est pas un état', () => {
    expect(readLidarCommentState({ version: 1, type: 'HELLO' })).toBeNull();
    expect(readLidarCommentState({ type: 'STATE', projectId: 'p', me: {} })).toBeNull();
    expect(readLidarCommentState(null)).toBeNull();
  });
});
