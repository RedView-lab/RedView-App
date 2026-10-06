import { describe, expect, it } from 'vitest';

import { applyCommentAction, type CommentAuthor } from '@/features/comments/lib/commentActions';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';
import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

import { MAX_ROOM_CHARS, RoomState } from '../room/roomState';
import { routeChunkId } from '../routeChunks';
import { randomEdit, sampleDocument, simUserId } from '../sim/fixtures';
import { seededRandom } from '../sim/scheduler';
import { diffDocument, documentOps } from './diff';
import { Materializer } from './materialize';
import { ObjectStore } from './objects';
import { applyOps, type Op } from './ops';
import { checkBatch } from './validate';

/**
 * Validation des lots par le serveur (validate.ts) :
 *  - aucun lot qu'un client honnête produit n'est refusé (il serait perdu) :
 *    milliers de modifications aléatoires « comme dans l'app » ;
 *  - chaque attaque connue est refusée en entier, sans rien appliquer.
 */

const alice: CommentAuthor = { userId: 'u-alice', name: 'Alice' };
const bob: CommentAuthor = { userId: 'u-bob', name: 'Bob' };

function withComments(document: ProjectDocument, comments: readonly ProjectCommentThread[] | null): ProjectDocument {
  const next = { ...document } as ProjectDocument & { comments?: ProjectCommentThread[] };
  if (comments && comments.length > 0) next.comments = [...comments];
  else delete next.comments;
  return next;
}

/** Salle avec un fil d'Alice auquel Bob a répondu. */
function roomWithThread(): RoomState {
  const state = RoomState.fromDocument(sampleDocument(300), 0);
  let seq = 0;
  for (const [action, me] of [
    [{ type: 'create-thread', threadId: 'cm-1', messageId: 'm-1', anchor: { lng: 6.87, lat: 45.92, elevationM: 1035 }, text: 'Col fermé', at: 't0' }, alice],
    [{ type: 'reply', threadId: 'cm-1', messageId: 'm-2', text: 'Ah bon ?', at: 't1' }, bob],
  ] as const) {
    const prev = state.document();
    const comments = applyCommentAction(prev.comments ?? [], action, me)!;
    const { ops, blobs } = diffDocument(state.store, prev, withComments(prev, comments));
    seq += 1;
    expect(state.applyClientBatch({ clientId: me.userId, clientSeq: seq, ops, blobs: Object.fromEntries(blobs) }, me.userId, seq).kind).toBe('applied');
  }
  return state;
}

const THREAD = 'p/comments:cm-1';
const ALICE_MESSAGE = `${THREAD}/messages:m-1`;
const IT = 'p/itineraries:it-1';

/** Lot d'un attaquant (Bob) : refusé, et la salle inchangée. */
function expectRejected(state: RoomState, ops: unknown, blobs: Record<string, string> = {}, reason?: string | RegExp) {
  const before = JSON.stringify(state.snapshot());
  const outcome = state.applyClientBatch({ clientId: 'attaquant', clientSeq: Date.now(), ops, blobs }, bob.userId, 0);
  expect(outcome.kind).toBe('rejected');
  if (reason !== undefined && outcome.kind === 'rejected') expect(outcome.reason).toMatch(reason);
  expect(JSON.stringify(state.snapshot())).toBe(before);
}

describe('validation des lots : jamais un client honnête refusé', () => {
  it('premier remplissage d’un document complet', () => {
    const store = new ObjectStore();
    const { ops, blobs } = documentOps(store, sampleDocument(1_500));
    const check = checkBatch(store, ops, Object.fromEntries(blobs), { userId: 'u1' });
    expect(check.ok).toBe(true);
    if (check.ok) expect(Object.keys(check.blobs).sort()).toEqual([...blobs.keys()].sort());
  });

  it.each([1, 2, 3, 4, 5])('2 000 modifications aléatoires « comme dans l’app » (graine %i) : toutes acceptées', (seed) => {
    const random = seededRandom(seed);
    const state = RoomState.fromDocument(sampleDocument(400), 0);
    const materializer = new Materializer();
    const clients = ['a', 'b', 'c'];
    let document = materializer.materialize(state.store);
    let accepted = 0;
    for (let n = 0; n < 2_000; n += 1) {
      const clientId = clients[n % clients.length];
      const edit = randomEdit(document, random, clientId, n);
      if (!edit) continue;
      const { ops, blobs } = diffDocument(state.store, document, edit.document);
      if (ops.length === 0) continue;
      const outcome = state.applyClientBatch({ clientId, clientSeq: n + 1, ops, blobs: Object.fromEntries(blobs) }, simUserId(clientId), n);
      if (outcome.kind !== 'applied') throw new Error(`modification ${n} refusée : ${outcome.kind === 'rejected' ? outcome.reason : outcome.kind}`);
      accepted += 1;
      document = materializer.materialize(state.store);
    }
    expect(accepted).toBeGreaterThan(1_000);
  }, 60_000);
});

describe('validation des lots : attaques refusées', () => {
  it('la racine ne se supprime, ne se déplace ni ne se recrée (le serveur en mourait)', () => {
    const state = roomWithThread();
    expectRejected(state, [{ t: 'd', id: 'p' }], {}, 'root-protected');
    expectRejected(state, [{ t: 'm', id: 'p', pos: 'a0' }], {}, 'root-protected');
    expectRejected(state, [{ t: 'c', id: 'p', parent: 'p', field: 'x', pos: 'a0', props: [] }], {}, 'bad-create-id');
  });

  it('clés écrites sous une autre forme que la canonique (contournement des règles des commentaires)', () => {
    const state = roomWithThread();
    expectRejected(state, [{ t: 's', id: ALICE_MESSAGE, k: 'tex%74', v: 'Je modifie le message d’Alice' }], {}, 'bad-key');
    expectRejected(state, [{ t: 's', id: ALICE_MESSAGE, k: '%61uthorId', v: bob.userId }], {}, 'bad-key');
    expectRejected(state, [{ t: 's', id: THREAD, k: 'anchor.lng', v: 2 }], {}, /bad-key|comment-/);
    // Liste parallèle `comment%73` (= `comments`) qui remplacerait les fils, signés par n'importe qui.
    expectRejected(state, [{
      t: 'c', id: 'p/comment%73:faux', parent: 'p', field: 'comment%73', pos: 'a0',
      props: [['id', 'faux'], ['createdBy', alice.userId], ['anchor', { lng: 0, lat: 0, elevationM: null }]],
    }], {}, 'bad-create-id');
    expectRejected(state, [{ t: 'c', id: `${IT}/timeline:w%41`, parent: IT, field: 'timeline', pos: 'a0', props: [] }], {}, 'bad-create-id');
  });

  it('commentaires : liste fermée de clés, id non modifiable, nom et dates bornés', () => {
    const state = roomWithThread();
    expectRejected(state, [{ t: 's', id: THREAD, k: 'title', v: 'x' }], {}, 'comment-bad-key');
    const own = 'p/comments:cm-1/messages:m-2';
    expectRejected(state, [{ t: 's', id: own, k: 'id', v: 'm-1' }], {}, /comment-bad-message|bad-key/);
    expectRejected(state, [{ t: 's', id: own, k: 'authorName', v: 'x'.repeat(10_000) }], {}, 'comment-bad-author-name');
    expectRejected(state, [{ t: 's', id: own, k: 'createdAt', v: 'x'.repeat(500) }], {}, 'comment-bad-date');
  });

  it('clés `__proto__`, valeurs trop profondes, chemin à travers une valeur atomique', () => {
    const state = roomWithThread();
    expectRejected(state, [{ t: 's', id: 'p', k: '__proto__', v: { polluted: true } }], {}, 'bad-key');
    expectRejected(state, [{ t: 's', id: IT, k: 'priorities.__proto__', v: 1 }], {}, 'bad-key');
    expectRejected(state, [{ t: 's', id: IT, k: 'metrics', v: JSON.parse('{"__proto__":{"polluted":true}}') }], {}, 'forbidden-key');
    let deep: unknown = 1;
    for (let depth = 0; depth < 200; depth += 1) deep = [deep];
    expectRejected(state, [{ t: 's', id: IT, k: 'metrics', v: deep }], {}, 'value-too-deep');
    // `name` est atomique : `name.x` le remplacerait par un objet à la matérialisation.
    expectRejected(state, [{ t: 's', id: IT, k: 'name.x', v: 1 }], {}, 'bad-key');
  });

  it('champs dont un mauvais type ferait planter les autres éditeurs', () => {
    const state = roomWithThread();
    expectRejected(state, [{ t: 's', id: IT, k: 'name', v: { toString: 1 } }], {}, 'bad-itinerary-name');
    expectRejected(state, [{ t: 's', id: IT, k: 'color', v: 'red;background:url(https://evil)' }], {}, 'bad-itinerary-color');
    expectRejected(state, [{ t: 's', id: `${IT}/timeline:wp-a`, k: 'lat', v: '45.9' }], {}, 'bad-timeline-lat');
    expectRejected(state, [{ t: 's', id: `${IT}/timeline:wp-a`, k: 'id', v: 'autre' }], {}, 'bad-timeline-id');
    expectRejected(state, [{ t: 's', id: 'p', k: 'name', v: ['pas', 'un', 'texte'] }], {}, 'bad-root-name');
    // Champ de liste posé tel quel : un tableau ou null, jamais une valeur que l'app itérerait.
    expectRejected(state, [{ t: 's', id: 'p', k: 'itineraries', v: 'pas une liste' }], {}, 'bad-list-value');
    expectRejected(state, [{ t: 's', id: IT, k: 'timeline', v: { length: 3 } }], {}, 'bad-list-value');
    // Tracé : un en-tête de segments ou null, jamais un objet lu comme un tracé.
    expectRejected(state, [{ t: 's', id: IT, k: 'gpxRoute', v: { points: 5 } }], {}, 'bad-route-value');
  });

  it('segments de tracé : id vérifié, JSON canonique (injection dans projects.data), points', () => {
    const state = roomWithThread();
    const header = (ids: string[]) => ({ v: 1, meta: { name: null, source: 'brouter' }, points: ids });
    const send = (json: string, id = routeChunkId(json)) => [[{ t: 's', id: IT, k: 'gpxRoute', v: header([id]) }], { [id]: json }] as const;
    // Contenu qui ne correspond pas à l'id.
    expectRejected(state, ...send('[{"lat":45.9,"lon":6.9}]', 'cdeadbeef1'), 'bad-blob-id');
    // JSON qui, recollé tel quel, injecterait des clés dans le document stocké.
    expectRejected(state, ...send('[{"lat":1,"lon":2}],"injecte":{"x":1},"y":[{"lat":3,"lon":4}]'), 'bad-blob');
    // JSON valide mais non canonique (recollé, il casserait l'enveloppe du tableau).
    expectRejected(state, ...send(' [{"lat":1,"lon":2}] '), 'bad-blob');
    expectRejected(state, ...send('[{"lat":"45.9","lon":6.9}]'), 'bad-blob');
    expectRejected(state, ...send('[{"lat":1,"lon":2,"__proto__":{"x":1}}]'), 'forbidden-key');
    expectRejected(state, [{ t: 's', id: IT, k: 'gpxRoute', v: header(['../../etc']) }], {}, 'bad-route-header');
  });

  it('segments que rien ne référence : écartés (la mémoire de la salle ne gonfle pas)', () => {
    const state = roomWithThread();
    const json = '[{"lat":45.9,"lon":6.9}]';
    const outcome = state.applyClientBatch(
      { clientId: 'c', clientSeq: 1, ops: [{ t: 's', id: IT, k: 'name', v: 'Renommé' }], blobs: { [routeChunkId(json)]: json } },
      'u-c',
      0,
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.batch.blobs).toEqual({});
    expect(state.store.hasBlob(routeChunkId(json))).toBe(false);
  });

  it('champs en trop dans une opération : jamais journalisés ni diffusés', () => {
    const state = roomWithThread();
    const outcome = state.applyClientBatch(
      { clientId: 'c', clientSeq: 1, ops: [{ t: 's', id: IT, k: 'name', v: 'X', junk: 'y'.repeat(1_000) } as unknown as Op], blobs: {} },
      'u-c',
      0,
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome.batch.ops).toEqual([{ t: 's', id: IT, k: 'name', v: 'X' }]);
  });

  it('`clientId` d’un autre éditeur : ses lots ne passent pas (ils feraient passer ceux du titulaire pour des doublons)', () => {
    const state = roomWithThread();
    // Bob réutilise le clientId d'Alice (diffusé dans la présence) avec un numéro de lot énorme.
    const hijack = state.applyClientBatch({ clientId: alice.userId, clientSeq: 1e9, ops: [{ t: 's', id: IT, k: 'name', v: 'X' }], blobs: {} }, bob.userId, 0);
    expect(hijack).toEqual({ kind: 'rejected', reason: 'client-id-taken' });
    // Le lot suivant d'Alice passe toujours.
    const next = state.applyClientBatch({ clientId: alice.userId, clientSeq: 2, ops: [{ t: 's', id: IT, k: 'name', v: 'Alice' }], blobs: {} }, alice.userId, 0);
    expect(next.kind).toBe('applied');
    // Le titulaire survit au point de sauvegarde.
    const reloaded = new RoomState(state.store, state.seq, state.clientSeqs(), state.clientUserMap());
    expect(reloaded.clientOwner(alice.userId)).toBe(alice.userId);
  });

  it('salle pleine : les gros lots sont refusés, les petits passent encore', () => {
    const state = roomWithThread();
    state.setSizeChars(MAX_ROOM_CHARS - 10);
    const big = state.applyClientBatch({ clientId: 'c', clientSeq: 1, ops: [{ t: 's', id: IT, k: 'metrics', v: { blob: 'x'.repeat(200_000) } }], blobs: {} }, 'u-c', 0);
    expect(big).toEqual({ kind: 'rejected', reason: 'room-too-large' });
    const small = state.applyClientBatch({ clientId: 'c', clientSeq: 2, ops: [{ t: 's', id: IT, k: 'name', v: 'Court' }], blobs: {} }, 'u-c', 0);
    expect(small.kind).toBe('applied');
  });

  it('un lot refusé ne laisse rien derrière lui (ni opérations, ni segments)', () => {
    const state = roomWithThread();
    const json = '[{"lat":45.9,"lon":6.9}]';
    const store = state.store.clone();
    const check = checkBatch(store, [
      { t: 's', id: IT, k: 'gpxRoute', v: { v: 1, meta: {}, points: [routeChunkId(json)] } },
      { t: 'd', id: 'p' },
    ], { [routeChunkId(json)]: json }, { userId: bob.userId });
    expect(check.ok).toBe(false);
    applyOps(store, []);
    expect(store.hasBlob(routeChunkId(json))).toBe(false);
  });
});
