/**
 * Tranches et arrondis : ce qui part vers la mesure d'audience ne donne jamais
 * une valeur exacte rattachable à un compte (nombre de projets, de points…).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProjectAgeBucket = 'today' | 'this_week' | 'this_month' | 'older' | 'unknown';

/** Ancienneté de la dernière sauvegarde d'un projet qu'on rouvre : un retour, sans savoir qui revient. */
export function projectAgeBucket(updatedAt: string | null | undefined, now = Date.now()): ProjectAgeBucket {
  const time = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(time)) return 'unknown';
  const days = (now - time) / DAY_MS;
  if (days < 1) return 'today';
  if (days < 7) return 'this_week';
  if (days < 30) return 'this_month';
  return 'older';
}

export type AccountAgeBucket = 'd0' | 'd1_7' | 'd8_30' | 'd30_plus';

/** Ancienneté du compte (date d'inscription Appwrite) : jour même, première semaine, premier mois, au-delà. */
export function accountAgeBucket(registeredAt: string | null | undefined, now = Date.now()): AccountAgeBucket | undefined {
  const time = registeredAt ? Date.parse(registeredAt) : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  const days = (now - time) / DAY_MS;
  if (days < 1) return 'd0';
  if (days < 8) return 'd1_7';
  if (days < 31) return 'd8_30';
  return 'd30_plus';
}

/** Tranche d'un compte (« 1 », « 2-5 », « 6-20 », « 21-100 », « >100 ») : jamais la valeur exacte. */
export function countBucket(count: number): string {
  if (count <= 1) return String(Math.max(0, count));
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '>100';
}

/** Arrondi au pas donné (distance à 10 km, dénivelé à 100 m, durée à 100 ms…). */
export function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0;
  return Math.round(value / step) * step;
}

/** Durée en tranches lisibles : « <1s », « 1-3s », « 3-10s », « 10-30s », « 30-60s », « >60s ». */
export function durationBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  if (ms < 3000) return '1-3s';
  if (ms < 10_000) return '3-10s';
  if (ms < 30_000) return '10-30s';
  if (ms < 60_000) return '30-60s';
  return '>60s';
}

/** Part d'avancement en tranches (lecture flyover…) : « <25 », « 25-50 », « 50-75 », « 75-99 », « 100 ». */
export function percentBucket(fraction: number): string {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  if (pct >= 99.5) return '100';
  if (pct >= 75) return '75-99';
  if (pct >= 50) return '50-75';
  if (pct >= 25) return '25-50';
  return '<25';
}

/** Longue durée (rendu vidéo…) : « <1min », « 1-3min », « 3-10min », « 10-30min », « >30min ». */
export function longDurationBucket(ms: number): string {
  const minutes = Number.isFinite(ms) ? ms / 60_000 : 0;
  if (minutes < 1) return '<1min';
  if (minutes < 3) return '1-3min';
  if (minutes < 10) return '3-10min';
  if (minutes < 30) return '10-30min';
  return '>30min';
}
