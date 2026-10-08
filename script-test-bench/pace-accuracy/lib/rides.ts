/**
 * Banc de précision du temps de déplacement — vérité terrain.
 *
 * Décode les .fit de référence (Cham→Paris de Jo) avec @garmin/fitsdk,
 * indépendamment du parseur Rust du moteur, et en tire :
 *  - la trace « en mouvement » (arrêts et dérive GPS à l'arrêt retirés),
 *  - le temps de déplacement réel cumulé le long de cette trace,
 *  - les pauses (position + durée).
 *
 * Les .fit ne sont pas versionnés : dossier par défaut = celui des audits
 * (c-lib.ts), surchargeable par PACE_FIT_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';

import { CHAM_PARIS_FIT_DIR } from '../../core/data-paths.ts';

export const FIT_DIR = process.env.PACE_FIT_DIR ?? CHAM_PARIS_FIT_DIR;

/** Sorties de référence, dans l'ordre du voyage. */
export const RIDES = [
  { id: 'D1', file: 'CHAM_PARIS_à_vélo_JOUR_1.fit', label: 'J1 Chamonix → Genève (Forclaz)' },
  { id: 'D2', file: 'Morning_Ride.fit', label: 'J2 Genève → Lons (Faucille)' },
  { id: 'D3a', file: 'CHAMONIX_PARIS_à_vélo_JOUR_3 (1).fit', label: 'J3 matin Lons → Dole' },
  { id: 'D3b', file: 'CHAMONIX_PARIS_à_vélo_JOUR_3.fit', label: 'J3 après-midi → Dijon' },
  { id: 'D4', file: 'CHAMONIX_PARIS_à_vélo.fit', label: 'J4 Dijon → Troyes' },
  { id: 'D5', file: 'Sortie_vélo_le_matin (1).fit', label: 'J5 Troyes → Paris' },
] as const;

export type RideId = string;

export interface RideMeta {
  id: string;
  file: string;
  label: string;
  /** Dossier du fichier (défaut : FIT_DIR). */
  dir?: string;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** Altitude barométrique (m). */
  ele: number;
  /** Distance cumulée le long de la trace en mouvement (m, haversine). */
  d: number;
  /** Temps de déplacement cumulé (s). */
  t: number;
  /** Horodatage absolu (s epoch). */
  epoch: number;
}

export interface Pause {
  /** Position le long de la trace (m). */
  d: number;
  /** Instant (s epoch) du début de l'arrêt. */
  epoch: number;
  durationS: number;
}

export interface Ride {
  id: RideId;
  label: string;
  file: string;
  bytes: Uint8Array;
  startEpoch: number;
  elapsedS: number;
  timerS: number | null;
  movingTimeS: number;
  distanceM: number;
  /** Distance parcourue pendant des trous d'enregistrement (> maxGapS) : sans temps réel associé. */
  gapDistanceM: number;
  track: TrackPoint[];
  pauses: Pause[];
  hasHeartRate: boolean;
}

export interface TruthOptions {
  /** Vitesse minimale (m/s) pour qu'un intervalle compte comme roulé. */
  minMovingSpeedMs?: number;
  /** Intervalle maximal (s) entre deux points pour qu'il compte comme roulé. */
  maxGapS?: number;
  /** Durée minimale (s) d'un arrêt pour être listé comme pause. */
  minPauseS?: number;
}

const SEMI_TO_DEG = 180 / 2 ** 31;
const EARTH_RADIUS_M = 6_371_008.8;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

interface RawRecord { epoch: number; lat: number; lon: number; alt: number; dist: number | null; hr: number | null }

function decodeRecords(bytes: Uint8Array): { records: RawRecord[]; session: Record<string, unknown> | null } {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  const { messages, errors } = decoder.read();
  if (errors.length > 0) throw new Error(`FIT illisible : ${String(errors[0])}`);
  const records: RawRecord[] = [];
  for (const m of (messages.recordMesgs ?? []) as Record<string, unknown>[]) {
    const lat = m.positionLat as number | undefined;
    const lon = m.positionLong as number | undefined;
    const ts = m.timestamp as Date | undefined;
    const alt = (m.enhancedAltitude ?? m.altitude) as number | undefined;
    if (lat == null || lon == null || !ts || alt == null) continue;
    records.push({
      epoch: ts.getTime() / 1000,
      lat: lat * SEMI_TO_DEG,
      lon: lon * SEMI_TO_DEG,
      alt,
      dist: typeof m.distance === 'number' ? m.distance : null,
      hr: typeof m.heartRate === 'number' ? m.heartRate : null,
    });
  }
  records.sort((a, b) => a.epoch - b.epoch);
  const session = ((messages.sessionMesgs ?? []) as Record<string, unknown>[])[0] ?? null;
  return { records, session };
}

export function extractRide(
  meta: RideMeta,
  opts: TruthOptions = {},
): Ride {
  const minSpeed = opts.minMovingSpeedMs ?? 0.6;
  const maxGap = opts.maxGapS ?? 30;
  const minPause = opts.minPauseS ?? 60;
  const file = path.join(meta.dir ?? FIT_DIR, meta.file);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { records, session } = decodeRecords(bytes);
  if (records.length < 2) throw new Error(`${meta.id}: pas assez de points`);

  const track: TrackPoint[] = [];
  const pauses: Pause[] = [];
  let d = 0;
  let t = 0;
  let gapDistanceM = 0;
  let stoppedSince: number | null = null;
  let stoppedAtD = 0;
  let last = records[0]!;
  track.push({ lat: last.lat, lon: last.lon, ele: last.alt, d: 0, t: 0, epoch: last.epoch });

  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    const dt = cur.epoch - prev.epoch;
    if (dt <= 0) continue;
    const ddFit = cur.dist != null && prev.dist != null ? cur.dist - prev.dist : null;
    const ddGps = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
    const dd = ddFit != null && ddFit >= 0 ? ddFit : ddGps;
    const moving = dt <= maxGap && dd / dt >= minSpeed;

    if (moving) {
      if (stoppedSince != null) {
        const durationS = prev.epoch - stoppedSince;
        if (durationS >= minPause) pauses.push({ d: stoppedAtD, epoch: stoppedSince, durationS });
        stoppedSince = null;
      }
      // Distance mesurée depuis le dernier point retenu : la dérive GPS pendant
      // l'arrêt n'est pas comptée, seul le déplacement net l'est.
      const step = haversineM(last.lat, last.lon, cur.lat, cur.lon);
      d += step;
      t += dt;
      track.push({ lat: cur.lat, lon: cur.lon, ele: cur.alt, d, t, epoch: cur.epoch });
      last = cur;
    } else {
      if (stoppedSince == null) {
        stoppedSince = prev.epoch;
        stoppedAtD = d;
      }
      if (dt > maxGap) {
        // Trou d'enregistrement (minuterie arrêtée) : si l'on a bougé pendant
        // le trou, la distance est réelle mais sans temps roulé mesurable.
        const jump = haversineM(last.lat, last.lon, cur.lat, cur.lon);
        if (jump > 50) {
          gapDistanceM += jump;
          d += jump;
          track.push({ lat: cur.lat, lon: cur.lon, ele: cur.alt, d, t, epoch: cur.epoch });
          last = cur;
        }
      }
    }
  }
  if (stoppedSince != null) {
    const durationS = records[records.length - 1]!.epoch - stoppedSince;
    if (durationS >= minPause) pauses.push({ d: stoppedAtD, epoch: stoppedSince, durationS });
  }

  const first = records[0]!;
  const lastRec = records[records.length - 1]!;
  return {
    id: meta.id,
    label: meta.label,
    file,
    bytes,
    startEpoch: first.epoch,
    elapsedS: lastRec.epoch - first.epoch,
    timerS: typeof session?.totalTimerTime === 'number' ? session.totalTimerTime : null,
    movingTimeS: t,
    distanceM: d,
    gapDistanceM,
    track,
    pauses,
    hasHeartRate: records.some((r) => r.hr != null),
  };
}

export function loadRides(opts: TruthOptions = {}): Ride[] {
  return RIDES.map((meta) => extractRide(meta, opts));
}

/** Toutes les sorties .fit d'un dossier, triées par date, identifiants `prefix1…n`. */
export function loadRidesFromDir(dir: string, prefix = 'R', opts: TruthOptions = {}): Ride[] {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fit'));
  const rides = files.map((file) => extractRide({ id: file, file, dir, label: file.replace(/\.fit$/i, '').replace(/_/g, ' ').trim() }, opts));
  rides.sort((a, b) => a.startEpoch - b.startEpoch);
  return rides.map((r, i) => ({ ...r, id: `${prefix}${i + 1}` }));
}

/** Temps réel cumulé (s) à la distance d (m) le long de la trace. */
export function realTimeAt(track: TrackPoint[], d: number): number {
  if (d <= 0) return 0;
  const lastPt = track[track.length - 1]!;
  if (d >= lastPt.d) return lastPt.t;
  let lo = 0;
  let hi = track.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.d <= d) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  const span = b.d - a.d;
  return span > 0 ? a.t + (b.t - a.t) * ((d - a.d) / span) : a.t;
}

export function formatHms(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}
