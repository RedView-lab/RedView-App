/** Utilitaires du banc de charge du VPS : statistiques, hasard déterministe, budget de requêtes. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Générateur xorshift32 (graine ≠ 0) : un utilisateur virtuel rejoue la même suite d'actions d'une passe à l'autre. */
export function createRandom(seed: number) {
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    between: (min: number, max: number) => min + (max - min) * next(),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length) % items.length]!,
    /** Choix pondéré : [[valeur, poids], …]. */
    weighted: <T>(entries: ReadonlyArray<readonly [T, number]>): T => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
    /** Loi exponentielle de moyenne `mean`, bornée. */
    exponential: (mean: number, min: number, max: number) => Math.min(max, Math.max(min, -Math.log(1 - next()) * mean)),
  };
}
export type Random = ReturnType<typeof createRandom>;

export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  // Rang le plus proche (p95 de 20 valeurs = la 19e) : jamais une interpolation optimiste.
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank]!;
}

export interface Summary {
  n: number;
  ok: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Statuts / erreurs les plus fréquents. */
  failures: Record<string, number>;
}

/** Une mesure : durée d'une action, réussite, et la raison d'un échec (statut HTTP, délai, refus…). */
export interface Sample {
  name: string;
  ms: number;
  ok: boolean;
  at: number;
  why?: string;
}

export function summarize(samples: readonly Sample[]): Summary {
  const okSamples = samples.filter((sample) => sample.ok).map((sample) => sample.ms).sort((a, b) => a - b);
  const failures: Record<string, number> = {};
  for (const sample of samples) if (!sample.ok) failures[sample.why ?? 'erreur'] = (failures[sample.why ?? 'erreur'] ?? 0) + 1;
  return {
    n: samples.length,
    ok: okSamples.length,
    errors: samples.length - okSamples.length,
    p50: percentile(okSamples, 0.5),
    p95: percentile(okSamples, 0.95),
    p99: percentile(okSamples, 0.99),
    max: okSamples.length ? okSamples[okSamples.length - 1]! : Number.NaN,
    mean: okSamples.length ? okSamples.reduce((sum, value) => sum + value, 0) / okSamples.length : Number.NaN,
    failures,
  };
}

/**
 * Budget glissant de requêtes (fenêtre de 60 s) : la limite publique de
 * server.mjs est de 120 requêtes d'API par minute et par IP, et tout le
 * générateur partage l'IP du portable. Une action qui ne trouve pas son
 * budget n'est PAS retardée (cela fausserait sa latence) : elle est sautée
 * et comptée à part.
 */
export function createBudget(perMinute: number) {
  const stamps: number[] = [];
  const prune = (now: number) => {
    while (stamps.length > 0 && now - stamps[0]! >= 60_000) stamps.shift();
  };
  return {
    get unlimited() {
      return !Number.isFinite(perMinute);
    },
    /** Réserve `count` requêtes maintenant, ou refuse sans rien consommer. */
    reserve(count: number): boolean {
      if (!Number.isFinite(perMinute)) return true;
      const now = Date.now();
      prune(now);
      if (stamps.length + count > perMinute) return false;
      for (let index = 0; index < count; index += 1) stamps.push(now);
      return true;
    },
    /** Requête faite hors réservation (une action qui en a demandé plus que prévu). */
    consume(count = 1): void {
      if (!Number.isFinite(perMinute)) return;
      const now = Date.now();
      for (let index = 0; index < count; index += 1) stamps.push(now);
    },
    used(): number {
      prune(Date.now());
      return stamps.length;
    },
  };
}
export type Budget = ReturnType<typeof createBudget>;

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Décale un point de `meters` dans une direction aléatoire (déplacement d'un point de passage). */
export function jitterPoint(random: Random, point: { lat: number; lon: number }, meters: number) {
  const angle = random.between(0, Math.PI * 2);
  const distance = random.between(meters * 0.3, meters);
  const dLat = (distance * Math.cos(angle)) / 111_320;
  const dLon = (distance * Math.sin(angle)) / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  return { lat: point.lat + dLat, lon: point.lon + dLon };
}
