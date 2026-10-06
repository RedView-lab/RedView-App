/**
 * Lecture en différé des flux d'un autre éditeur (caméra, pointeur, survol du
 * graphique), comme l'interpolation d'entités des jeux en réseau : les
 * échantillons arrivent horodatés par l'émetteur, jusqu'à 30 Hz, avec de la
 * gigue ; on les rejoue un peu dans le passé (juste assez pour avoir presque
 * toujours l'échantillon suivant), interpolés à chaque image — fluide à
 * 60–144 Hz, sans saut, sans dépassement.
 *
 *  - `PlayoutClock` : temps de l'émetteur à afficher maintenant. Décalage
 *    émetteur → local = minimum glissant de `arrivée − t` (le paquet le plus
 *    rapide fixe la base, la dérive des horloges est suivie) ; délai =
 *    intervalle entre échantillons + gigue (p95), borné ; le retard total
 *    change en douceur (lecture un peu plus lente ou plus rapide, jamais un
 *    saut ni un retour en arrière).
 *  - `SampleTrack` : un flux (vecteur de nombres, ou absent), interpolé en
 *    Hermite monotone (PCHIP : jamais au-delà des valeurs reçues), angles
 *    déroulés (plus court chemin), sans extrapolation (on tient le dernier
 *    échantillon), reprise après un silence recalée (pas de ralenti de
 *    rattrapage).
 */

/** Fenêtre du minimum de `arrivée − t`. */
const OFFSET_WINDOW_MS = 5_000;
/** Bornes du délai de lecture ajouté au décalage. */
const MIN_PLAYOUT_DELAY_MS = 40;
export const MAX_PLAYOUT_DELAY_MS = 300;
/** Intervalle supposé avant d'en avoir mesuré un (≈ 20 Hz). */
const DEFAULT_INTERVAL_MS = 50;
/** Au-delà, deux échantillons ne sont pas de la même rafale (l'émetteur était au repos). */
const BURST_GAP_MS = 250;
/** Vitesse de lecture pendant un rattrapage du retard : ± 5 % pour un petit écart, jusqu'à ± 25 %. */
const MIN_SLEW = 0.05;
const MAX_SLEW = 0.25;
/** Écart de retard (ms) qui donne la vitesse de rattrapage maximale. */
const SLEW_SCALE_MS = 400;
const JITTER_SAMPLES = 64;
const INTERVAL_SAMPLES = 32;
/** Échantillons gardés derrière le plus récent, même si personne ne lit. */
const KEEP_BEHIND_NEWEST_MS = 3_000;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export class PlayoutClock {
  /** Observations `arrivée − t` de la fenêtre, dans l'ordre d'arrivée. */
  private readonly offsets: Array<{ at: number; offset: number }> = [];
  private readonly jitters: number[] = [];
  private readonly intervals: number[] = [];
  private lastSenderT: number | null = null;
  /** Retard total appliqué (décalage + délai), lissé. */
  private lag: number | null = null;
  private lastPlaybackAt: number | null = null;
  /** Dernier temps joué (jamais de retour en arrière). */
  private lastPlayback: number | null = null;

  /**
   * Échantillon en direct reçu à `arrival` (temps local). `senderWasAtRest` :
   * ses flux s'étaient posés (dernier état répété par l'image clé de repos).
   */
  observe(senderT: number, arrival: number, senderWasAtRest = true): void {
    if (this.lastSenderT !== null && senderT < this.lastSenderT) this.reset();
    if (this.lastSenderT !== null) {
      const interval = senderT - this.lastSenderT;
      if (interval > 0 && interval < BURST_GAP_MS) push(this.intervals, interval, INTERVAL_SAMPLES);
      // L'émetteur reprend après un repos (trou dans SES horodatages, flux posés) :
      // la lecture repart au retard visé ; sauter le repos ne se voit pas (rien n'y
      // bougeait). Un trou en plein mouvement (onglet de l'émetteur ralenti) ou un
      // réseau bloqué se rattrapent en douceur, jamais d'un saut.
      else if (interval >= BURST_GAP_MS && senderWasAtRest) this.lag = null;
    }
    this.lastSenderT = senderT;
    const offset = arrival - senderT;
    this.offsets.push({ at: arrival, offset });
    while (this.offsets.length > 1 && this.offsets[0].at < arrival - OFFSET_WINDOW_MS) this.offsets.shift();
    push(this.jitters, offset - this.minOffset(), JITTER_SAMPLES);
  }

  get ready(): boolean {
    return this.offsets.length > 0;
  }

  /** Délai visé au-delà du paquet le plus rapide : un intervalle + la gigue. */
  targetDelay(): number {
    const interval = this.intervals.length > 0 ? percentile(this.intervals, 0.5) : DEFAULT_INTERVAL_MS;
    const jitter = percentile(this.jitters, 0.95);
    return Math.min(MAX_PLAYOUT_DELAY_MS, Math.max(MIN_PLAYOUT_DELAY_MS, interval * 1.1 + jitter));
  }

  /** Temps de l'émetteur à afficher à `now` (null tant qu'aucun échantillon en direct n'est arrivé). */
  playbackTime(now: number): number | null {
    if (!this.ready) return null;
    const target = this.minOffset() + this.targetDelay();
    if (this.lag === null || this.lastPlaybackAt === null || now - this.lastPlaybackAt > 1_000) {
      // Premier appel, nouvelle rafale, ou boucle restée à l'arrêt : rien d'affiché à raccorder.
      this.lag = target;
    } else {
      // Vitesse de lecture ajustée en proportion de l'écart (≤ ± 25 %) : un
      // gros retard pris pendant un blocage se rattrape en une seconde ou deux.
      const dt = Math.max(0, now - this.lastPlaybackAt);
      const excess = target - this.lag;
      const rate = Math.min(MAX_SLEW, Math.max(MIN_SLEW, Math.abs(excess) / SLEW_SCALE_MS));
      const step = rate * dt;
      this.lag += Math.max(-step, Math.min(step, excess));
    }
    // Jamais au-delà du plus récent échantillon : à court (réseau bloqué), le
    // temps s'arrête là au lieu de courir puis de sauter quand tout arrive.
    if (this.lastSenderT !== null && now - this.lag > this.lastSenderT) this.lag = now - this.lastSenderT;
    // Jamais en arrière (un retard visé qui augmente d'un coup après une reprise).
    if (this.lastPlayback !== null && now - this.lag < this.lastPlayback) this.lag = now - this.lastPlayback;
    this.lastPlaybackAt = now;
    this.lastPlayback = now - this.lag;
    return this.lastPlayback;
  }

  reset(): void {
    this.offsets.length = 0;
    this.jitters.length = 0;
    this.intervals.length = 0;
    this.lastSenderT = null;
    this.lag = null;
    this.lastPlaybackAt = null;
    this.lastPlayback = null;
  }

  private minOffset(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const { offset } of this.offsets) if (offset < min) min = offset;
    return min;
  }
}

function push(values: number[], value: number, limit: number): void {
  values.push(value);
  if (values.length > limit) values.shift();
}

/** Échantillon d'un flux : valeurs (null : absent, ex. pointeur hors de la carte), identité discrète, charge utile. */
export interface Sample<P = unknown> {
  t: number;
  values: number[] | null;
  /** Identité discrète (itinéraire survolé…) : jamais d'interpolation entre deux identités. */
  key?: string;
  /** Donnée jointe, prise telle quelle (zone visible de l'émetteur avec sa caméra). */
  payload?: P;
}

export interface TrackSample<P = unknown> {
  values: number[] | null;
  key?: string;
  payload?: P;
  /** Plus rien à jouer après ce temps : le flux est au repos (dernier échantillon atteint). */
  settled: boolean;
}

export interface SampleTrackOptions {
  /** Indices des composantes angulaires (période 360°) : déroulées au plus court. */
  wrap?: readonly number[];
  /** Durée gardée derrière le temps de lecture (ms). */
  keepMs?: number;
}

/** Flux d'échantillons d'un éditeur, rejoué en Hermite monotone. */
export class SampleTrack<P = unknown> {
  private samples: Array<Sample<P>> = [];
  private readonly wrap: readonly number[];
  private readonly keepMs: number;

  constructor(options: SampleTrackOptions = {}) {
    this.wrap = options.wrap ?? [];
    this.keepMs = options.keepMs ?? 1_500;
  }

  get size(): number {
    return this.samples.length;
  }

  get last(): Sample<P> | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * Flux posé : ses deux derniers échantillons sont le même état (l'émetteur
   * renvoie l'état complet ≈ 250 ms après l'arrêt), ou il n'en a qu'un.
   */
  isSettled(): boolean {
    const count = this.samples.length;
    if (count < 2) return true;
    const a = this.samples[count - 2];
    const b = this.samples[count - 1];
    if (a.key !== b.key) return false;
    if (!a.values || !b.values) return a.values === b.values;
    return a.values.length === b.values.length && a.values.every((value, index) => value === b.values![index]);
  }

  /**
   * Ajoute un échantillon (ordre de l'émetteur). Un `t` qui recule (onglet de
   * l'émetteur rechargé) repart de zéro ; après un silence où le flux était
   * posé, un échantillon de repos est recalé juste avant : le mouvement
   * commence là où il a commencé vraiment, pas étalé sur tout le silence.
   * (Un silence en plein mouvement, lui, est interpolé.)
   */
  push(sample: Sample<P>): void {
    const last = this.last;
    if (last && sample.t <= last.t) {
      if (sample.t === last.t) this.samples[this.samples.length - 1] = this.unwrapped(sample, this.samples[this.samples.length - 2] ?? null);
      else this.samples = [this.unwrapped(sample, null)];
      return;
    }
    if (last && sample.t - last.t > BURST_GAP_MS && this.isSettled()) {
      const restT = sample.t - Math.min(DEFAULT_INTERVAL_MS, (sample.t - last.t) / 2);
      if (restT > last.t) this.samples.push({ ...last, t: restT });
    }
    this.samples.push(this.unwrapped(sample, this.last));
    // Personne ne lit (onglet en arrière-plan) : la liste reste bornée.
    while (this.samples.length > 3 && this.samples[1].t < sample.t - KEEP_BEHIND_NEWEST_MS) this.samples.shift();
  }

  /** Remplace tout par un état connu (sans horloge : `welcome`). */
  resetTo(sample: Sample<P>): void {
    this.samples = [this.unwrapped(sample, null)];
  }

  clear(): void {
    this.samples = [];
  }

  /** Valeur à jouer au temps de l'émetteur `time` (null : aucune horloge encore, on tient le dernier). */
  sample(time: number | null): TrackSample<P> | null {
    const { samples } = this;
    if (samples.length === 0) return null;
    const lastIndex = samples.length - 1;
    if (time === null || time >= samples[lastIndex].t) {
      const last = samples[lastIndex];
      return { values: last.values ? this.wrapped(last.values) : null, key: last.key, payload: last.payload, settled: true };
    }
    this.prune(time);
    const list = this.samples;
    if (time <= list[0].t) {
      const first = list[0];
      return { values: first.values ? this.wrapped(first.values) : null, key: first.key, payload: first.payload, settled: false };
    }
    let index = 0;
    while (index < list.length - 2 && list[index + 1].t <= time) index += 1;
    const a = list[index];
    const b = list[index + 1];
    // Absent, ou autre identité : on garde l'état de départ jusqu'à l'échantillon suivant.
    if (!a.values || !b.values || a.key !== b.key || a.values.length !== b.values.length) {
      return { values: a.values ? this.wrapped(a.values) : null, key: a.key, payload: a.payload, settled: false };
    }
    const prev = list[index - 1];
    const next = list[index + 2];
    const usable = (sample: Sample<P> | undefined) => (sample?.values && sample.key === a.key && sample.values.length === a.values!.length ? sample : undefined);
    const values = hermite(usable(prev), a, b, usable(next), time);
    return { values: this.wrapped(values), key: a.key, payload: a.payload, settled: false };
  }

  /** Échantillons trop anciens retirés (on en garde toujours deux avant `time`). */
  private prune(time: number): void {
    let drop = 0;
    while (drop < this.samples.length - 3 && this.samples[drop + 2].t < time - this.keepMs) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** Angles déroulés par rapport à l'échantillon précédent (au plus court). */
  private unwrapped(sample: Sample<P>, previous: Sample<P> | null): Sample<P> {
    if (!sample.values || this.wrap.length === 0) return sample;
    const values = sample.values.slice();
    if (previous?.values && previous.values.length === values.length && previous.key === sample.key) {
      for (const index of this.wrap) {
        const delta = values[index] - previous.values[index];
        values[index] -= 360 * Math.round(delta / 360);
      }
    }
    return { ...sample, values };
  }

  private wrapped(values: number[]): number[] {
    if (this.wrap.length === 0) return values;
    const out = values.slice();
    for (const index of this.wrap) out[index] = normalizeAngle(out[index]);
    return out;
  }
}

/** Angle ramené dans [-180, 180). */
export function normalizeAngle(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** Pente monotone de Fritsch–Carlson en `b` (entre les sécantes a→b et b→c). */
function monotoneSlope(a: Sample, b: Sample, c: Sample | undefined, index: number): number {
  const h0 = b.t - a.t;
  const d0 = (b.values![index] - a.values![index]) / h0;
  if (!c) return d0;
  const h1 = c.t - b.t;
  const d1 = (c.values![index] - b.values![index]) / h1;
  if (d0 === 0 || d1 === 0 || Math.sign(d0) !== Math.sign(d1)) return 0;
  const w1 = 2 * h1 + h0;
  const w2 = h1 + 2 * h0;
  return (w1 + w2) / (w1 / d0 + w2 / d1);
}

/** Hermite cubique monotone entre `a` et `b` (voisins `prev`/`next` pour les pentes). */
function hermite(prev: Sample | undefined, a: Sample, b: Sample, next: Sample | undefined, time: number): number[] {
  const h = b.t - a.t;
  const s = (time - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const out: number[] = [];
  for (let index = 0; index < a.values!.length; index += 1) {
    const ya = a.values![index];
    const yb = b.values![index];
    const secant = (yb - ya) / h;
    let ma = prev ? monotoneSlope(prev, a, b, index) : secant;
    let mb = next ? monotoneSlope(a, b, next, index) : secant;
    // Pentes bornées (Fritsch–Carlson) : la courbe ne dépasse jamais les valeurs reçues.
    if (secant === 0) {
      ma = 0;
      mb = 0;
    } else {
      const alpha = ma / secant;
      const beta = mb / secant;
      const norm = alpha * alpha + beta * beta;
      if (alpha < 0) ma = 0;
      if (beta < 0) mb = 0;
      if (norm > 9) {
        const tau = 3 / Math.sqrt(norm);
        ma = tau * alpha * secant;
        mb = tau * beta * secant;
      }
    }
    out.push(h00 * ya + h10 * h * ma + h01 * yb + h11 * h * mb);
  }
  return out;
}
