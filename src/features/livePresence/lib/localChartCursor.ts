/**
 * Ce que cet éditeur survole sur le graphique d'analyse (ou sur la trace) :
 * l'itinéraire et la distance depuis son départ, quel que soit le mode d'axe
 * (distance, temps, heure : chacun voit le sien). Écrit par le point de survol
 * du centre (centerPanel), lu par l'émetteur de présence (canal `motion`).
 * Hors React, sans dépendance : rien ne coûte sans session de co-édition.
 */

export interface ChartCursor {
  itineraryId: string;
  distanceM: number;
}

type Listener = () => void;

let current: ChartCursor | null = null;
const listeners = new Set<Listener>();

export function setLocalChartCursor(next: ChartCursor | null): void {
  if (next && !Number.isFinite(next.distanceM)) next = null;
  if (current === next) return;
  if (current && next && current.itineraryId === next.itineraryId && Math.abs(current.distanceM - next.distanceM) < 0.5) return;
  current = next ? { itineraryId: next.itineraryId, distanceM: Math.max(0, next.distanceM) } : null;
  for (const listener of [...listeners]) listener();
}

export function getLocalChartCursor(): ChartCursor | null {
  return current;
}

export function subscribeLocalChartCursor(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
