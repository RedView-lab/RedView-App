import { describe, expect, it } from 'vitest';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { diffDocument } from '../../src/features/collab/model/diff.ts';
import type { SequencedBatch } from '../../src/features/collab/protocol.ts';
import { RoomState } from '../../src/features/collab/room/roomState.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { storeDigest, verifyDurable } from './shadow.ts';
import type { DurableState } from './storage.ts';

/** Validation fantôme : état durable (point de sauvegarde + journal) rejoué = mémoire ? */

function rename(state: RoomState, clientSeq: number, name: string): SequencedBatch {
  const prev = state.document();
  const next = { ...prev, itineraries: prev.itineraries.map((it) => (it.id === 'it-1' ? { ...it, name } : it)) } as ProjectDocument;
  const { ops, blobs } = diffDocument(state.store, prev, next);
  const outcome = state.applyClientBatch({ clientId: 'a', clientSeq, ops, blobs: Object.fromEntries(blobs) }, 'u', clientSeq);
  if (outcome.kind !== 'applied') throw new Error(outcome.kind);
  return outcome.batch;
}

function scenario() {
  const state = RoomState.fromDocument(sampleDocument(200), 0);
  const checkpoint = { seq: state.seq, snapshot: state.snapshot(), clientSeqs: state.clientSeqs() };
  const journal = [rename(state, 1, 'Un'), rename(state, 2, 'Deux'), rename(state, 3, 'Trois')];
  return { state, durable: { checkpoint, journal } satisfies DurableState };
}

describe('validation fantôme', () => {
  it('état durable rejoué jusqu’à la séquence = mémoire', () => {
    const { state, durable } = scenario();
    expect(verifyDurable(durable, state.seq, storeDigest(state.store))).toEqual({ ok: true });
  });

  it('signale un lot altéré, un trou dans le journal, un point de sauvegarde illisible', () => {
    const { state, durable } = scenario();
    const expected = storeDigest(state.store);
    const altered = structuredClone(durable);
    const last = altered.journal.pop()!;
    expect(verifyDurable(altered, state.seq, expected)).toMatchObject({ ok: false, reason: expect.stringContaining('incomplet') });
    // Dernier lot altéré (le précédent serait recouvert : dernier écrit gagne).
    altered.journal.push({ ...last, ops: last.ops.map((op) => (op.t === 's' ? { ...op, v: 'Altéré' } : op)) });
    expect(verifyDurable(altered, state.seq, expected)).toMatchObject({ ok: false, reason: 'état rejoué différent de la mémoire' });
    const gap = { ...durable, journal: [durable.journal[0], durable.journal[2]] };
    expect(verifyDurable(gap, state.seq, expected)).toMatchObject({ ok: false, reason: expect.stringContaining('discontinu') });
    expect(verifyDurable(null, state.seq, expected).ok).toBe(false);
  });
});
