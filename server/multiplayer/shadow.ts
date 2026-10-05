import { createHash } from 'node:crypto';

import { canonicalJson } from '../../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import { referencedRouteBlobs } from '../../src/features/collab/model/diff.ts';
import type { ObjectStore } from '../../src/features/collab/model/objects.ts';
import { deserializeStore } from '../../src/features/collab/protocol.ts';
import { RoomState } from '../../src/features/collab/room/roomState.ts';
import type { DurableState } from './storage.ts';

/**
 * Validation « fantôme » en production : de temps en temps, juste avant un
 * point de sauvegarde, l'état durable (point de sauvegarde précédent +
 * journal, relus du stockage) est rejoué jusqu'à la séquence du nouveau et
 * comparé à l'état en mémoire à cette séquence. C'est l'invariant du
 * simulateur (« journal relu = mémoire ») vérifié sur les vraies salles : un
 * écart (journal incomplet ou discontinu, sérialisation, rejeu) est signalé,
 * rien n'est modifié.
 */

/** Empreinte d'un état : objets triés par id, propriétés triées et canoniques, segments référencés présents. */
export function storeDigest(store: ObjectStore): string {
  const hash = createHash('sha256');
  const objects = [...store.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const object of objects) {
    const props = [...object.props.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, canonicalJson(value)]);
    hash.update(JSON.stringify([object.id, object.parent, object.field, object.pos, props]));
    hash.update('\n');
  }
  // Segments adressés par leur contenu : leur présence suffit.
  for (const id of [...referencedRouteBlobs(store)].sort()) hash.update(`${store.hasBlob(id) ? 'blob' : 'missing'}:${id}\n`);
  return hash.digest('hex');
}

export type ShadowResult = { ok: true } | { ok: false; reason: string };

/** Rejoue l'état durable jusqu'à `seq` et le compare à l'empreinte de la mémoire à cette séquence. */
export function verifyDurable(durable: DurableState | null, seq: number, expected: string): ShadowResult {
  if (!durable) return { ok: false, reason: 'point de sauvegarde illisible' };
  const { checkpoint } = durable;
  if (checkpoint.seq > seq) return { ok: false, reason: `point de sauvegarde en avance (${checkpoint.seq} > ${seq})` };
  const state = new RoomState(deserializeStore(checkpoint.snapshot), checkpoint.seq, checkpoint.clientSeqs);
  for (const batch of durable.journal) {
    if (batch.seq > seq) break;
    if (batch.seq !== state.seq + 1) return { ok: false, reason: `journal discontinu (${batch.seq} au lieu de ${state.seq + 1})` };
    state.replay(batch);
  }
  if (state.seq !== seq) return { ok: false, reason: `journal incomplet (${state.seq} < ${seq})` };
  return storeDigest(state.store) === expected ? { ok: true } : { ok: false, reason: 'état rejoué différent de la mémoire' };
}
