/**
 * Propriétaire courant de la caméra quand une feature la pilote image par
 * image (flyover). Lisible hors React : les automatismes caméra (rotation
 * d'inactivité, menu contextuel) s'effacent tant qu'il y a un propriétaire.
 */

export type CameraOwner = 'flyover';

type Listener = (owner: CameraOwner | null) => void;

let owner: CameraOwner | null = null;
const listeners = new Set<Listener>();

export function getCameraOwner(): CameraOwner | null {
  return owner;
}

export function setCameraOwner(next: CameraOwner | null): void {
  if (owner === next) return;
  owner = next;
  for (const listener of listeners) listener(next);
}

export function subscribeCameraOwner(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
