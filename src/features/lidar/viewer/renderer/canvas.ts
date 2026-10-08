/** Id du canvas du viewer dans viewer.html. */
const VIEWER_CANVAS_ID = 'canvas';

/** Canvas déjà pris par un moteur (et donc par un type de contexte). */
const claimed = new WeakSet<HTMLCanvasElement>();

/**
 * Le canvas du viewer, prêt pour un nouveau contexte de rendu. Un canvas garde
 * le premier type de contexte créé dessus (`webgpu`, `webgl2`) : un moteur qui
 * prend le relais d'un autre reçoit donc une copie neuve de l'élément,
 * substituée sur place (même id, attributs et taille). À appeler avant
 * d'attacher le moindre écouteur au canvas.
 */
export function claimViewerCanvas(): HTMLCanvasElement {
  const current = document.getElementById(VIEWER_CANVAS_ID);
  if (!(current instanceof HTMLCanvasElement)) throw new Error('viewer canvas missing');
  if (!claimed.has(current)) {
    claimed.add(current);
    return current;
  }
  const fresh = current.cloneNode(false) as HTMLCanvasElement;
  current.replaceWith(fresh);
  claimed.add(fresh);
  return fresh;
}
