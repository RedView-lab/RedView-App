/**
 * Audit domaine C — helpers partagés (lecture GPX, chargement WASM, fetch throttlé).
 * Aucun code applicatif n'est modifié : on importe src/ tel quel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BENCH_DATA_DIR, CHAM_PARIS_FIT_DIR, GT20_GPX } from '../core/data-paths.ts';

export const DL = BENCH_DATA_DIR;
export const FIT_DIR = CHAM_PARIS_FIT_DIR;
export const GT20 = GT20_GPX;
export const TDF = path.join(DL, 'Tour de France 2026.gpx');

export type RoutePoint = { lat: number; lon: number; elevationM: number | null };

export function readGpxPoints(file: string): RoutePoint[] {
  const text = fs.readFileSync(file, 'utf8');
  const pts: RoutePoint[] = [];
  const re = /<(trkpt|rtept)\s+([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of text.matchAll(re)) {
    const attrs = m[2]!;
    const lat = /lat="([-\d.eE]+)"/.exec(attrs);
    const lon = /lon="([-\d.eE]+)"/.exec(attrs);
    if (!lat || !lon) continue;
    const ele = m[4] ? /<ele>([-\d.eE]+)<\/ele>/.exec(m[4]) : null;
    pts.push({ lat: Number(lat[1]), lon: Number(lon[1]), elevationM: ele ? Number(ele[1]) : null });
  }
  return pts;
}

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function routeLength(points: { lat: number; lon: number }[]): number {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += haversineM(points[i - 1]!, points[i]!);
  return t;
}

const PKG = path.resolve('src/features/fitPredictor/engine/pkg');
export async function loadWasm(): Promise<any> {
  // Nouveau module à chaque appel (query string) : instance WASM fraîche.
  const url = pathToFileURL(path.join(PKG, 'redviewalgo.js'));
  url.search = `?i=${Math.random()}`;
  const glue = await import(url.href);
  glue.initSync({ module: fs.readFileSync(path.join(PKG, 'redviewalgo_bg.wasm')) });
  return glue;
}

export function silenceConsole<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

export function mb(n: number) { return (n / 1048576).toFixed(1); }

let lastFetch = 0;
export let fetchCount = 0;
/** fetch avec >= 3,2 s entre deux requêtes (limite partagée 120 req/min/IP). */
export async function throttledFetch(url: string, init?: RequestInit, minGapMs = 3200) {
  const wait = lastFetch + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  fetchCount++;
  return fetch(url, init);
}
