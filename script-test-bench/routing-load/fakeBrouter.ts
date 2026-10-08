/**
 * Faux BRouter autonome du banc de charge du routage (processus enfant de
 * run.ts). Ne calcule rien : il reproduit les règles de
 * `btools.server.RouteServer` (BRouter 1.7.10, lues dans sa source) qui
 * décident de la charge et des attentes —
 *  - un fil par connexion. Quand `maxthreads` fils vivent déjà, la boucle
 *    d'acceptation (une seule, pour TOUTES les connexions) attend jusqu'à
 *    2 000 ms moins l'âge du plus ancien (réveillée par une fin de fil),
 *    puis, si c'est toujours plein, tue le plus ancien (« operation killed by
 *    thread-priority-watchdog ») ;
 *  - aucun client parti n'est détecté : un calcul va au bout, ou jusqu'à
 *    `maxRunningTime` ;
 *  - envoi de profil (`ProfileUploadHandler`) : le corps lu, le fil dort
 *    1 000 ms avant de répondre.
 * Le calcul d'un tracé est un travail CPU (secondes) partagé entre les fils
 * actifs sur `cores` cœurs (partage du processeur) : somme sur ses tronçons
 * de `k × d^1,05 × (1,1 / poids)^0,8` (d : km à vol d'oiseau ; poids =
 * pass1coefficient / 1,4), bruit log-normal. Sous 1 cœur libre par fil, les
 * calculs ralentissent tous ensemble, comme sur l'hôte.
 *
 * Réponse : GeoJSON du tracé (polyligne densifiée le long des points demandés,
 * longueur, coût) — de quoi faire tourner le vrai pipeline client (ancres,
 * comparaison de coût). Mesures (IPC `stats`) : calculs lancés, livrés,
 * abandonnés par le client, tués, expirés, attente de la boucle
 * d'acceptation, CPU dépensé et CPU dépensé pour personne.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const MAX_THREADS = Number(process.env.FAKE_BROUTER_THREADS ?? 4);
const CORES = Number(process.env.FAKE_BROUTER_CORES ?? 3);
const MAX_RUNNING_MS = Number(process.env.FAKE_BROUTER_MAX_RUNNING_S ?? 300) * 1000;
const WORK_K = Number(process.env.FAKE_BROUTER_WORK_K ?? 0.008);
const WORK_EXP = Number(process.env.FAKE_BROUTER_WORK_EXP ?? 1.05);
const UPLOAD_SLEEP_MS = 1_000;
const TICK_MS = 10;

interface Job {
  id: number;
  kind: 'route' | 'upload';
  startedAt: number;
  /** Travail CPU restant (s) ; un envoi n'en a pas (il dort). */
  remaining: number;
  work: number;
  terminated: boolean;
  /** Le client (le proxy) a fermé sa connexion avant la réponse. */
  clientGone: boolean;
  finish(outcome: 'done' | 'killed' | 'timeout'): void;
}

const stats = {
  routes: 0,
  uploads: 0,
  delivered: 0,
  abandoned: 0,
  killed: 0,
  timedOut: 0,
  contentionWaits: 0,
  contentionWaitMs: 0,
  cpuSeconds: 0,
  /** CPU des calculs dont personne n'a eu le résultat (client parti, tué, expiré). */
  wastedCpuSeconds: 0,
  maxLive: 0,
};

let nextId = 0;
const live: Job[] = [];
const profiles = new Set<string>();
let wakeAccept: (() => void) | null = null;

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function gaussian(): number {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function routeWork(points: Array<[number, number]>, pass1: number): number {
  const weight = Math.max(0.3, pass1 / 1.4);
  let work = 0.05;
  for (let i = 1; i < points.length; i += 1) work += WORK_K * haversineKm(points[i - 1], points[i]) ** WORK_EXP * (1.1 / weight) ** 0.8;
  return work * Math.exp(0.45 * gaussian());
}

function geojson(points: Array<[number, number]>, pass1: number): string {
  const coordinates: Array<[number, number, number]> = [];
  let beelineM = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const km = haversineKm(a, b);
    beelineM += km * 1000;
    const steps = Math.max(2, Math.min(800, Math.round(km * 2)));
    for (let step = i === 1 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      const wiggle = Math.sin(t * Math.PI * 7) * 0.002 * Math.min(1, km / 10);
      coordinates.push([a[0] + (b[0] - a[0]) * t + wiggle, a[1] + (b[1] - a[1]) * t - wiggle, 500]);
    }
  }
  const lengthM = Math.round(beelineM * 1.25);
  const weight = Math.max(0.3, pass1 / 1.4);
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        'track-length': String(lengthM),
        'total-time': String(Math.round(lengthM / 5)),
        'filtered ascend': String(Math.round(lengthM * 0.01)),
        'plain-ascend': '0',
        // Plus glouton = un peu plus coûteux (l'affinage doit faire mieux que le tracé grossier).
        cost: String(Math.round(lengthM * 1.4 * (1 + 0.04 * weight))),
      },
      geometry: { type: 'LineString', coordinates },
    }],
  });
}

/** Partage du processeur : à chaque pas, chaque calcul avance de min(1, cœurs / calculs actifs). */
setInterval(() => {
  const now = Date.now();
  const computing = live.filter((job) => job.kind === 'route' && !job.terminated);
  const rate = computing.length > 0 ? Math.min(1, CORES / computing.length) : 0;
  for (const job of computing) {
    const step = (TICK_MS / 1000) * rate;
    job.remaining -= step;
    stats.cpuSeconds += step;
    if (now - job.startedAt > MAX_RUNNING_MS) job.finish('timeout');
    else if (job.remaining <= 0) job.finish('done');
  }
}, TICK_MS).unref();

function removeTerminated(): void {
  for (let i = live.length - 1; i >= 0; i -= 1) if (live[i].terminated) live.splice(i, 1);
}

/** Boucle d'acceptation : une connexion à la fois, comme RouteServer.main. */
const acceptQueue: Array<() => void> = [];
let accepting = false;

async function acceptLoop(): Promise<void> {
  if (accepting) return;
  accepting = true;
  while (acceptQueue.length > 0) {
    const start = acceptQueue.shift()!;
    const arrivedAt = Date.now();
    removeTerminated();
    if (live.length >= MAX_THREADS) {
      const oldest = live.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
      const maxWait = 2_000 - (arrivedAt - oldest.startedAt);
      if (maxWait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wakeAccept = null;
            resolve();
          }, maxWait);
          wakeAccept = () => {
            clearTimeout(timer);
            wakeAccept = null;
            resolve();
          };
        });
      }
      stats.contentionWaits += 1;
      stats.contentionWaitMs += Date.now() - arrivedAt;
      removeTerminated();
      if (live.length >= MAX_THREADS) {
        const victim = live.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
        victim.finish('killed');
        removeTerminated();
      }
    }
    start();
  }
  accepting = false;
}

function startJob(kind: Job['kind'], work: number, res: http.ServerResponse, respond: (outcome: 'done' | 'killed' | 'timeout') => void): Job {
  const job: Job = {
    id: (nextId += 1),
    kind,
    startedAt: Date.now(),
    remaining: work,
    work,
    terminated: false,
    clientGone: false,
    finish(outcome) {
      if (job.terminated) return;
      job.terminated = true;
      const spent = job.work - Math.max(0, job.remaining);
      if (kind === 'route') {
        if (outcome === 'killed') stats.killed += 1;
        else if (outcome === 'timeout') stats.timedOut += 1;
        if (job.clientGone || outcome !== 'done') stats.wastedCpuSeconds += spent;
        if (job.clientGone && outcome === 'done') stats.abandoned += 1;
        else if (outcome === 'done') stats.delivered += 1;
      }
      if (!res.destroyed) respond(outcome);
      wakeAccept?.();
    },
  };
  res.on('close', () => {
    if (!job.terminated) job.clientGone = true;
  });
  live.push(job);
  stats.maxLive = Math.max(stats.maxLive, live.filter((other) => !other.terminated).length);
  return job;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    acceptQueue.push(() => {
      if (res.destroyed) return;
      if (req.method === 'POST' && url.pathname.startsWith('/brouter/profile/')) {
        const profileId = decodeURIComponent(url.pathname.slice('/brouter/profile/'.length));
        stats.uploads += 1;
        const job = startJob('upload', 0, res, () => {
          profiles.add(profileId);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ profileid: profileId }));
        });
        setTimeout(() => job.finish('done'), UPLOAD_SLEEP_MS);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/brouter') {
        const points = (url.searchParams.get('lonlats') ?? '').split('|').map((pair) => pair.split(',').map(Number) as [number, number]);
        const profile = url.searchParams.get('profile') ?? '';
        const pass1 = Number(url.searchParams.get('profile:pass1coefficient') ?? 1.5);
        if (profile.startsWith('custom_') && !profiles.has(profile)) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end(`error: profile ${profile.slice(7)}.brf does not exist`);
          return;
        }
        stats.routes += 1;
        startJob('route', routeWork(points, pass1), res, (outcome) => {
          if (outcome === 'done') {
            res.writeHead(200, { 'content-type': 'application/vnd.geo+json' }).end(geojson(points, pass1));
          } else {
            const seconds = Math.round(MAX_RUNNING_MS / 1000);
            const message = outcome === 'killed'
              ? 'operation killed by thread-priority-watchdog after 2 seconds'
              : `operation timeout after ${seconds} seconds`;
            res.writeHead(400, { 'content-type': 'text/plain' }).end(message);
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    void acceptLoop();
  });
});
server.keepAliveTimeout = 5_000;
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: (server.address() as AddressInfo).port }));
process.on('message', (message: { type: string }) => {
  if (message.type === 'stats') {
    process.send?.({ type: 'stats', stats: { ...stats, liveAtEnd: live.filter((job) => !job.terminated).length } });
  }
});
process.on('disconnect', () => process.exit(0));
