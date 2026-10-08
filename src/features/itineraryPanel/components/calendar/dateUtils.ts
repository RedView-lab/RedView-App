/**
 * Outils de dates du popover de calendrier.
 *
 * Toutes les fonctions sont pures et stables vis-à-vis du fuseau (on travaille
 * toujours à minuit local pour éviter le bug UTC classique
 * `new Date('2025-01-10').getDate() === 9`).
 */

/** Parse une chaîne ISO `yyyy-mm-dd` en Date à minuit local, ou null. */
export function parseISO(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Met en forme une Date en `yyyy-mm-dd` en heure locale. */
export function toISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Renvoie minuit aujourd'hui (local). */
export function startOfToday(): Date {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

/** Vrai quand les deux dates sont le même jour calendaire (local). */
export function isSameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Indice du jour de la semaine avec lundi = 0 … dimanche = 6. */
export function mondayIndex(d: Date): number {
  // JS : 0 = dimanche … 6 = samedi → décaler pour que lundi = 0.
  return (d.getDay() + 6) % 7;
}

/** Décale une Date de `n` mois, en bornant le jour à la longueur du nouveau mois. */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}
