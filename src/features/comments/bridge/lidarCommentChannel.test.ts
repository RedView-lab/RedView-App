import { describe, expect, it } from 'vitest';

import { answersLidarHello, isForLidarViewerProject, readLidarCommentState } from './lidarCommentChannel';

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

describe('plusieurs onglets de l’app sur des projets différents (C2-2)', () => {
  const state = (projectId: string) => ({
    version: 1 as const, type: 'STATE' as const, projectId, updatedAt: 't', me: { userId: 'u-1', name: 'Alice' }, members: [], threads: [], reads: {},
  });

  it('le visualiseur n’accepte que l’état et la fermeture de son projet', () => {
    expect(isForLidarViewerProject(state('alpes'), 'alpes')).toBe(true);
    expect(isForLidarViewerProject(state('pyrenees'), 'alpes')).toBe(false);
    expect(isForLidarViewerProject({ version: 1, type: 'CLOSED', projectId: 'pyrenees' }, 'alpes')).toBe(false);
    // Visualiseur ouvert sans projet (version précédente, à la main) : comme avant.
    expect(isForLidarViewerProject(state('pyrenees'), null)).toBe(true);
  });

  it('seul l’onglet du projet du visualiseur répond à son HELLO', () => {
    expect(answersLidarHello({ version: 1, type: 'HELLO', projectId: 'alpes' }, 'alpes')).toBe(true);
    expect(answersLidarHello({ version: 1, type: 'HELLO', projectId: 'alpes' }, 'pyrenees')).toBe(false);
    expect(answersLidarHello({ version: 1, type: 'HELLO' }, 'pyrenees')).toBe(true);
  });
});
