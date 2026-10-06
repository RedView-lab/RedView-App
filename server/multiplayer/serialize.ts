import type { DocObject } from '../../src/features/collab/model/objects.ts';
import type { RoomState } from '../../src/features/collab/room/roomState.ts';

/**
 * Sérialisation des points de sauvegarde, sur le fil de la salle : les objets
 * du document sont immuables (un objet modifié est remplacé), donc le JSON de
 * chacun est gardé par identité et seul ce qui a changé depuis le point
 * précédent est resérialisé. Les segments de tracé, eux, ne sont pas copiés :
 * leur JSON est déjà en mémoire (magasin de la salle), il est recollé à
 * chaque point de sauvegarde. Le document de `projects.data` est écrit à part
 * (`materializeJson`), sans être construit. La compression gzip tourne hors
 * du fil (zlib, pool de libuv) : un gros projet ne bloque pas les autres
 * salles.
 */
export class CheckpointSerializer {
  private readonly objects = new WeakMap<DocObject, string>();

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
    const blobs: string[] = [];
    for (const id of state.store.blobIds()) blobs.push(`${JSON.stringify(id)}:${JSON.stringify(state.store.getBlob(id))}`);
    const seq = state.seq;
    return `{"seq":${seq},"snapshot":{"seq":${seq},"objects":[${objects.join(',')}],"blobs":{${blobs.join(',')}}},`
      + `"clientSeqs":${JSON.stringify(state.clientSeqs())},"clientUsers":${JSON.stringify(state.clientUserMap())}}`;
  }
}
