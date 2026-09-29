/**
 * Capture la souris sur l'élément. Tente d'abord l'input brut
 * (`unadjustedMovement`, sans accélération OS, comme un jeu), puis retombe sur
 * le mode standard si le navigateur ne le supporte pas.
 */
export function lockPointer(element: HTMLElement): void {
  if (document.pointerLockElement === element) return;
  try {
    const request = element.requestPointerLock({ unadjustedMovement: true });
    if (request && typeof request.catch === 'function') {
      request.catch(() => {
        try {
          element.requestPointerLock()?.catch?.(() => {});
        } catch {
          /* refusé (pas de geste utilisateur, cooldown après Échap) : un clic recapture */
        }
      });
    }
  } catch {
    /* navigateur sans pointer lock */
  }
}

export function unlockPointer(element: HTMLElement): void {
  if (document.pointerLockElement === element) {
    document.exitPointerLock();
  }
}

export function isPointerLockedOn(element: HTMLElement): boolean {
  return document.pointerLockElement === element;
}
