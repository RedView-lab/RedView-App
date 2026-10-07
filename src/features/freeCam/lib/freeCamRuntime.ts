/**
 * État global minimal de la FreeCam, lisible hors React : les autres features
 * (raccourcis itinéraire, rotation cinématique, sauvegarde du viewport, menu
 * contextuel, flyover) s'en servent pour se mettre en pause pendant le vol.
 */

import { trackAnalyticsEvent } from '@/shared/lib/analytics';

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();
let exitHandler: (() => void) | null = null;

export function isFreeCamActive(): boolean {
  return active;
}

export function subscribeFreeCam(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setFreeCamActive(next: boolean): void {
  if (active === next) return;
  active = next;
  if (next) trackAnalyticsEvent({ name: 'freecam_entered' });
  for (const listener of listeners) listener(next);
}

/** Enregistré par `useFreeCam` ; permet à une autre feature de forcer la sortie. */
export function registerFreeCamExitHandler(handler: (() => void) | null): void {
  exitHandler = handler;
}

export function requestFreeCamExit(): void {
  if (active) exitHandler?.();
}
