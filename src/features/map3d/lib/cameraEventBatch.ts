import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Regroupement des événements caméra d'un pilote image par image (flyover,
 * suivi d'un éditeur). `setFreeCameraOptions` / `jumpTo` émettent movestart /
 * move / moveend (+ zoom, rotate, pitch start/end) à chaque appel. Image par
 * image, chaque `moveend` vide le cache de drapage des lignes du terrain,
 * force le miroir flou, sauvegarde le viewport… Tant que le pilote tient la
 * caméra, on retrouve la sémantique d'une animation Mapbox : un seul *start,
 * les `move`/`zoom`/`rotate`/`pitch` à chaque image, un seul *end à la fin.
 *
 * Seuls les événements marqués par le pilote (`{ [marker]: true }` passé en
 * données d'événement) sont regroupés ; le patch est une propriété propre de
 * l'instance, retirée à la libération (sans effet si un autre patch s'est
 * posé par-dessus : le nôtre devient alors transparent).
 */

const BATCHED_START_EVENTS = new Set(['movestart', 'zoomstart', 'rotatestart', 'pitchstart']);
const BATCHED_END_EVENTS: Record<string, string> = {
  zoomend: 'zoomstart',
  rotateend: 'rotatestart',
  pitchend: 'pitchstart',
  moveend: 'movestart',
};
const END_EVENT_ORDER = ['zoomend', 'rotateend', 'pitchend', 'moveend'] as const;

export interface CameraEventBatch {
  /** Rend `fire` d'origine et émet les fins de mouvement en attente. */
  release: () => void;
}

function isMarked(event: unknown, eventData: unknown, marker: string): boolean {
  const data = typeof event === 'string' ? eventData : event;
  return (data as Record<string, unknown> | null | undefined)?.[marker] === true;
}

export function batchDrivenCameraEvents(map: MapboxMap, marker: string): CameraEventBatch {
  type Fire = (event: unknown, eventData?: unknown) => MapboxMap;
  const target = map as unknown as { fire: Fire };
  const hadOwnFire = Object.prototype.hasOwnProperty.call(target, 'fire');
  const originalFire = target.fire;
  const started = new Set<string>();
  const markerData = { [marker]: true };
  let released = false;

  const batchedFire = function batchedFire(this: MapboxMap, event: unknown, eventData?: unknown) {
    const type = typeof event === 'string' ? event : (event as { type?: string } | null)?.type;
    if (!released && type && isMarked(event, eventData, marker)) {
      if (BATCHED_START_EVENTS.has(type)) {
        if (started.has(type)) return this;
        started.add(type);
      } else if (type in BATCHED_END_EVENTS) {
        return this;
      }
    }
    return originalFire.call(this, event, eventData);
  };
  target.fire = batchedFire;

  return {
    release() {
      if (released) return;
      released = true;
      if (target.fire === batchedFire) {
        if (hadOwnFire) target.fire = originalFire;
        else delete (target as Partial<typeof target>).fire;
      }
      for (const end of END_EVENT_ORDER) {
        if (!started.has(BATCHED_END_EVENTS[end])) continue;
        try {
          (map as unknown as { fire: (type: string, data: object) => void }).fire(end, markerData);
        } catch {
          /* carte détruite */
        }
      }
    },
  };
}
