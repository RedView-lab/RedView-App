import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { DocObject } from '../../src/features/collab/model/objects.ts';
import type { RoomState } from '../../src/features/collab/room/roomState.ts';

/**
 * Sérialisation incrémentale des points de sauvegarde, sur le fil de la
 * salle : les objets du document sont immuables (un objet modifié est
 * remplacé), donc le JSON de chacun est gardé par identité et seul ce qui a
 * changé depuis le point précédent est resérialisé. Idem pour les segments
 * de tracé (immuables par id) et les itinéraires matérialisés (même objet
 * tant qu'ils ne changent pas). La compression gzip tourne hors du fil
 * (zlib, pool de libuv) : un gros projet ne bloque pas les autres salles.
 */
export class CheckpointSerializer {
  private readonly objects = new WeakMap<DocObject, string>();
  private blobs = new Map<string, string>();
  private readonly values = new WeakMap<object, string>();

  checkpoint(state: RoomState): string {
    const objects: string[] = [];
    for (const object of state.store.values()) {
      let json = this.objects.get(object);
      if (json === undefined) {
        json = JSON.stringify([object.id, object.parent, object.field, object.pos, [...object.props]]);
        this.objects.set(object, json);
      }
      objects.push(json);
    }
    const blobs = new Map<string, string>();
    for (const id of state.store.blobIds()) {
      blobs.set(id, this.blobs.get(id) ?? `${JSON.stringify(id)}:${JSON.stringify(state.store.getBlob(id))}`);
    }
    this.blobs = blobs;
    const seq = state.seq;
    return `{"seq":${seq},"snapshot":{"seq":${seq},"objects":[${objects.join(',')}],"blobs":{${[...blobs.values()].join(',')}}},`
      + `"clientSeqs":${JSON.stringify(state.clientSeqs())}}`;
  }

  /** JSON du document matérialisé (`projects.data`), itinéraires inchangés repris tels quels. */
  document(document: ProjectDocument): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(document)) {
      if (value === undefined) continue;
      if (key === 'itineraries' && Array.isArray(value)) {
        parts.push(`"itineraries":[${value.map((itinerary) => this.cached(itinerary)).join(',')}]`);
      } else {
        parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
      }
    }
    return `{${parts.join(',')}}`;
  }

  private cached(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    let json = this.values.get(value);
    if (json === undefined) {
      json = JSON.stringify(value);
      this.values.set(value, json);
    }
    return json;
  }
}
