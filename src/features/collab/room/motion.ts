import type {
  MotionCamera,
  MotionChart,
  MotionFields,
  MotionPointer,
  MotionState,
  MotionViewport,
} from '../protocol';

/**
 * Canal `motion` côté salle, sans réseau : nettoyage d'un message reçu
 * (n'importe quel client peut envoyer n'importe quoi), seau à jetons par
 * client (l'excès est jeté, jamais une fermeture : c'est un flux avec
 * pertes), fusion du dernier état connu (donné aux nouveaux arrivants).
 */

/** Messages par seconde tenus dans la durée (un client en envoie ≤ 30). */
const MOTION_RATE_PER_SECOND = 40;
/** Rafale permise (reprise après un onglet en arrière-plan, gigue). */
export const MOTION_BURST = 20;

const MAX_ID_LENGTH = 200;
const MAX_VIEWPORT_PX = 16_384;
const MAX_DISTANCE_M = 1e8;

/** Message `motion` nettoyé : seulement les champs connus, dans leurs bornes. */
export interface CleanMotion extends MotionFields {
  t: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return finite(value) && value >= min && value <= max;
}

function isTuple(value: unknown, length: number): value is unknown[] {
  return Array.isArray(value) && value.length === length;
}

/** Longitude déroulée (antiméridien) tolérée, latitude du globe. */
function validLngLat(lng: unknown, lat: unknown): boolean {
  return inRange(lng, -540, 540) && inRange(lat, -90, 90);
}

function cleanCamera(value: unknown): MotionCamera | null {
  if (!isTuple(value, 6)) return null;
  const [lng, lat, zoom, bearing, pitch, fov] = value;
  if (!validLngLat(lng, lat) || !inRange(zoom, 0, 26) || !inRange(bearing, -720, 720)
    || !inRange(pitch, 0, 90) || !inRange(fov, 1, 120)) {
    return null;
  }
  return [lng as number, lat as number, zoom, bearing, pitch, fov];
}

function cleanViewport(value: unknown): MotionViewport | null {
  if (!isTuple(value, 10)) return null;
  if (!inRange(value[0], 1, MAX_VIEWPORT_PX) || !inRange(value[1], 1, MAX_VIEWPORT_PX)) return null;
  for (let index = 2; index < 10; index += 1) {
    if (!inRange(value[index], 0, MAX_VIEWPORT_PX)) return null;
  }
  return value.slice() as MotionViewport;
}

function cleanPointer(value: unknown): MotionPointer | null | undefined {
  if (value === null) return null;
  if (!isTuple(value, 2) || !validLngLat(value[0], value[1])) return undefined;
  return [value[0] as number, value[1] as number];
}

function cleanChart(value: unknown): MotionChart | null | undefined {
  if (value === null) return null;
  if (!isTuple(value, 2)) return undefined;
  const [itineraryId, distanceM] = value;
  if (typeof itineraryId !== 'string' || itineraryId.length === 0 || itineraryId.length > MAX_ID_LENGTH) return undefined;
  if (!inRange(distanceM, 0, MAX_DISTANCE_M)) return undefined;
  return [itineraryId, distanceM];
}

/**
 * Message `motion` reçu → champs connus et valides ; null si l'horodatage ou
 * un champ présent est invalide (le message entier est ignoré : un client
 * honnête n'en envoie jamais).
 */
export function sanitizeMotion(message: unknown): CleanMotion | null {
  if (message === null || typeof message !== 'object') return null;
  const source = message as Record<string, unknown>;
  if (!inRange(source.t, 0, 1e13)) return null;
  const out: CleanMotion = { t: source.t };
  if (source.cam !== undefined) {
    const cam = cleanCamera(source.cam);
    if (!cam) return null;
    out.cam = cam;
  }
  if (source.vp !== undefined) {
    const vp = cleanViewport(source.vp);
    if (!vp) return null;
    out.vp = vp;
  }
  if (source.ptr !== undefined) {
    const ptr = cleanPointer(source.ptr);
    if (ptr === undefined) return null;
    out.ptr = ptr;
  }
  if (source.chart !== undefined) {
    const chart = cleanChart(source.chart);
    if (chart === undefined) return null;
    out.chart = chart;
  }
  return out;
}

/** Dernier état d'un client : les champs du message remplacent les anciens, les autres restent. */
export function mergeMotion(previous: MotionState | null, clientId: string, motion: CleanMotion): MotionState {
  const next: MotionState = { ...(previous ?? {}), clientId, t: motion.t };
  if (motion.cam !== undefined) next.cam = motion.cam;
  if (motion.vp !== undefined) next.vp = motion.vp;
  if (motion.ptr !== undefined) next.ptr = motion.ptr;
  if (motion.chart !== undefined) next.chart = motion.chart;
  return next;
}

/** Seau à jetons (horloge donnée) : `take` dit si un message de plus passe. */
export class MotionBucket {
  private tokens: number;
  private last: number | null = null;
  private readonly ratePerMs: number;
  private readonly burst: number;

  constructor(ratePerSecond = MOTION_RATE_PER_SECOND, burst = MOTION_BURST) {
    this.ratePerMs = ratePerSecond / 1000;
    this.burst = burst;
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.last !== null && now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.ratePerMs);
    }
    this.last = this.last === null ? now : Math.max(this.last, now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
