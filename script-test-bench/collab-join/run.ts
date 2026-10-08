/**
 * Banc d'entrée dans une salle et d'acquittement sous latence Appwrite
 * (`npm run bench:collab-join`). Le banc de charge du VPS (vps-load) mesure
 * le `welcome` depuis un portable dont le lien descendant sature à 100
 * utilisateurs : celui-ci isole la part du serveur. Vrai serveur temps réel
 * (server.ts, processus enfant), vrai stockage Appwrite et vraie
 * vérification des jetons / droits, contre un faux Appwrite à latence
 * log-normale (fakeAppwrite.ts, `--p50` / `--p95` : par défaut ceux
 * qu'Appwrite montrait à 100 utilisateurs) ; clients WebSocket légers sur la
 * boucle locale, qui entrent comme l'application (`hello` avec `compress`,
 * `leanEcho`) avec `--rtt` ms d'aller-retour avant leur `hello`.
 *
 * Par vague : redémarrage du serveur (salles froides, rechargées de leur point
 * de sauvegarde + journal), `--rooms` salles × `--users` éditeurs (le
 * premier propriétaire, les autres membres de l'équipe) qui arrivent sur
 * `--ramp` ms → temps jusqu'au `welcome` (froid) ; `--edit` s de
 * modifications (réglages, et tracés : lots de morceaux de route) → accusé
 * de l'auteur (et octets de cet accusé), diffusion aux autres ; puis chacun
 * se reconnecte (salle chargée) → `welcome` à chaud.
 *
 * `--roots a,b` : deux versions du code (dossiers, p. ex. une copie
 * `git archive` de HEAD et l'arbre de travail), une vague chacune à tour de
 * rôle (A/B entrelacé, ordre alterné) sur le même faux Appwrite.
 *
 *   npx tsx script-test-bench/collab-join/run.ts [--roots <a>,<b>] [--waves 4] [--rooms 9] [--users 3]
 *     [--ramp 3000] [--p50 150] [--p95 650] [--rtt 60] [--edit 20] [--label nom]
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

import { WebSocket } from 'ws';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { diffDocument } from '../../src/features/collab/model/diff.ts';
import { Materializer } from '../../src/features/collab/model/materialize.ts';
import type { ObjectStore } from '../../src/features/collab/model/objects.ts';
import { applyOps, type Op } from '../../src/features/collab/model/ops.ts';
import { deserializeStore, PROTOCOL_VERSION, socketProtocols, type ServerMessage } from '../../src/features/collab/protocol.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import { WIRE_COMPRESS_MIN_CHARS } from '../../src/features/collab/wire.ts';
import type { SeedProject } from './fakeAppwrite.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}
const ROOTS = arg('roots', repo).split(',').map((root) => path.resolve(root));
const WAVES = Number(arg('waves', '4'));
const ROOMS = Number(arg('rooms', '9'));
const USERS = Number(arg('users', '3'));
const RAMP_MS = Number(arg('ramp', '3000'));
const P50 = Number(arg('p50', '150'));
const P95 = Number(arg('p95', '650'));
const RTT_MS = Number(arg('rtt', '60'));
const EDIT_S = Number(arg('edit', '20'));
const LABEL = arg('label', `collab-join-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
const JWT_SECRET = 'banc-collab-join';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function waitFor<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (message: { type: string } & T) => {
      if (message.type !== type) return;
      child.off('message', listener);
      resolve(message);
    };
    child.on('message', listener);
  });
}

/** Document des salles : le projet de calibrage de vps-load (2 itinéraires) s'il est là, sinon un document de test. */
function roomDocument(): { document: ProjectDocument; source: string } {
  const fixture = path.join(repo, 'script-test-bench/reports/vps-load/fixtures/project-calibration.json');
  if (existsSync(fixture)) {
    const raw = JSON.parse(readFileSync(fixture, 'utf8')) as { data: string };
    const full = JSON.parse(gunzipSync(Buffer.from(raw.data.slice(3), 'base64')).toString('utf8')) as ProjectDocument & { itineraries: unknown[] };
    return { document: { ...full, itineraries: full.itineraries.slice(0, 2) } as ProjectDocument, source: 'projet de calibrage vps-load (2 itinéraires)' };
  }
  return { document: sampleDocument(4_000), source: 'sampleDocument(4000)' };
}

function jwtFor(userId: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId, sessionId: `s-${userId}`, exp: Math.floor(Date.now() / 1000) + 3_600 })}`;
  return `${head}.${createHmac('sha256', JWT_SECRET).update(head).digest('base64url')}`;
}

// ── Mesures ────────────────────────────────────────────────────────────────
type Series = Record<string, number[]>;
const results = new Map<string, Series>();
function record(root: string, name: string, value: number): void {
  let series = results.get(root);
  if (!series) {
    series = {};
    results.set(root, series);
  }
  (series[name] ??= []).push(value);
}

/** Envois en cours, sur l'horloge de ce processus : `clientId#clientSeq` → [instant, tracé ?]. */
const sentAt = new Map<string, [number, boolean]>();

// ── Clients ────────────────────────────────────────────────────────────────
interface RoomSpec {
  projectId: string;
  users: string[];
  itineraryId: string;
}

class BenchClient {
  readonly userId: string;
  private readonly room: RoomSpec;
  private socket: WebSocket | null = null;
  private store: ObjectStore | null = null;
  private clientId = '';
  private clientSeq = 0;
  private compress = false;
  /** Segments de ses propres lots : l'accusé peut revenir sans eux (`leanEcho`). */
  private readonly ownBlobs = new Map<number, Record<string, string>>();
  private root = '';
  ready = false;

  constructor(room: RoomSpec, userId: string) {
    this.room = room;
    this.userId = userId;
  }

  /** Ouvre une connexion ; résout au `welcome` (durée), ou null (refus, délai). */
  connect(port: number, root: string, kind: string): Promise<number | null> {
    this.root = root;
    this.clientId = `${this.userId}-${Math.random().toString(36).slice(2, 8)}`;
    this.clientSeq = 0;
    this.ownBlobs.clear();
    const t0 = performance.now();
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer?project=${this.room.projectId}`, socketProtocols(jwtFor(this.userId)), { perMessageDeflate: false });
      this.socket = socket;
      let settled = false;
      const settle = (value: number | null, why?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (value === null) record(root, `${kind}.échecs`, 1);
        if (why && value === null) console.warn(`  ${this.userId} : ${why}`);
        resolve(value);
      };
      const deadline = setTimeout(() => {
        settle(null, 'délai welcome');
        socket.terminate();
      }, 30_000);
      socket.on('open', () => {
        setTimeout(() => socket.send(JSON.stringify({
          type: 'hello', v: PROTOCOL_VERSION, clientId: this.clientId, epoch: null, lastSeq: null, compress: true, leanEcho: true,
        })), RTT_MS);
      });
      socket.on('error', (error) => settle(null, String(error)));
      socket.on('close', (code) => {
        this.ready = false;
        settle(null, `fermé ${code}`);
      });
      socket.on('message', (data, isBinary) => {
        const receivedAt = performance.now();
        const bytes = (data as Buffer).length;
        const message = JSON.parse(isBinary ? inflateRawSync(data as Buffer).toString('utf8') : String(data)) as ServerMessage;
        if (message.type === 'welcome') {
          this.compress = message.compress === true;
          if (message.snapshot) this.store = deserializeStore(message.snapshot);
          this.ready = this.store !== null;
          record(root, `${kind}.welcome-octets`, bytes);
          settle(receivedAt - t0);
        } else if (message.type === 'batch') {
          this.onBatch(message.batch, receivedAt, bytes);
        } else if (message.type === 'reject') {
          record(root, 'refus', 1);
        }
      });
    });
  }

  private onBatch(batch: { clientId: string; clientSeq: number; ops: Op[]; blobs: Record<string, string> }, receivedAt: number, bytes: number): void {
    const key = `${batch.clientId}#${batch.clientSeq}`;
    const sent = sentAt.get(key);
    const own = batch.clientId === this.clientId;
    if (sent) {
      const [at, route] = sent;
      const kind = route ? 'tracé' : 'réglage';
      if (own) {
        record(this.root, `accusé.${kind}`, receivedAt - at);
        if (route) record(this.root, 'accusé.tracé-octets', bytes);
      } else {
        record(this.root, `diffusion.${kind}`, receivedAt - at);
      }
    }
    if (!this.store) return;
    for (const [id, json] of Object.entries(batch.blobs ?? {})) this.store.putBlob(id, json);
    if (own) {
      for (const [id, json] of Object.entries(this.ownBlobs.get(batch.clientSeq) ?? {})) if (!this.store.hasBlob(id)) this.store.putBlob(id, json);
      this.ownBlobs.delete(batch.clientSeq);
    }
    applyOps(this.store, batch.ops);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(payload);
    if (this.compress && json.length >= WIRE_COMPRESS_MIN_CHARS) this.socket.send(deflateRawSync(json), { binary: true });
    else this.socket.send(json);
  }

  private sendBatch(ops: Op[], blobs: Record<string, string>, route: boolean): void {
    this.clientSeq += 1;
    this.ownBlobs.set(this.clientSeq, blobs);
    sentAt.set(`${this.clientId}#${this.clientSeq}`, [performance.now(), route]);
    this.send({ type: 'batch', clientSeq: this.clientSeq, ops, blobs });
  }

  /** Réglage : une propriété de l'itinéraire. */
  smallEdit(): void {
    if (!this.ready) return;
    this.sendBatch([{ t: 's', id: `p/itineraries:${this.room.itineraryId}`, k: 'name', v: `Itinéraire ${Math.floor(Math.random() * 1000)}` } as Op], {}, false);
  }

  /** Tracé modifié à partir d'un point (comme un point de passage déplacé) : morceaux de route nouveaux. */
  routeEdit(): void {
    if (!this.ready || !this.store) return;
    const prev = new Materializer().materialize(this.store) as any;
    const itineraries = prev.itineraries as any[];
    const index = itineraries.findIndex((itinerary) => itinerary.id === this.room.itineraryId);
    const points = itineraries[index]?.gpxRoute?.points as Array<Record<string, number>> | undefined;
    if (!points || points.length < 10) return;
    const from = Math.floor(points.length * between(0.3, 0.9));
    const shiftM = (Math.random() - 0.5) * 400;
    const nextPoints = points.map((point, i) => (i < from ? point : {
      ...point,
      lat: i < from + 40 ? point.lat + (Math.random() - 0.5) * 2e-4 : point.lat,
      distanceM: point.distanceM + shiftM,
    }));
    const next = {
      ...prev,
      itineraries: itineraries.map((itinerary, i) => (i !== index ? itinerary : { ...itinerary, gpxRoute: { ...itinerary.gpxRoute, points: nextPoints, routedInputsKey: `banc-${Date.now()}` } })),
    };
    const changes = diffDocument(this.store, prev, next);
    this.sendBatch(changes.ops, Object.fromEntries(changes.blobs), true);
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.ready = false;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000, 'fin');
    });
  }
}

// ── Déroulé ────────────────────────────────────────────────────────────────
const { document, source } = roomDocument();
const routeItinerary = (document.itineraries as Array<{ id: string; gpxRoute?: { points?: unknown[] } }>)
  .find((itinerary) => (itinerary.gpxRoute?.points?.length ?? 0) >= 10)!.id;
const data = `gz:${gzipSync(JSON.stringify(document)).toString('base64')}`;
const rooms: RoomSpec[] = Array.from({ length: ROOMS }, (_, room) => ({
  projectId: `banc${String(room).padStart(3, '0')}`,
  users: Array.from({ length: USERS }, (__, user) => `u${String(room).padStart(3, '0')}x${user}`),
  itineraryId: routeItinerary,
}));

const fake = fork(path.join(here, 'fakeAppwrite.ts'), [], {
  execArgv: ['--import', 'tsx'],
  env: { ...process.env, FAKE_APPWRITE_JWT_SECRET: JWT_SECRET },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const { port: fakePort } = await waitFor<{ port: number }>(fake, 'ready');
const fakeUrl = `http://127.0.0.1:${fakePort}`;
const post = (route: string, body: unknown) => fetch(`${fakeUrl}${route}`, { method: 'POST', body: JSON.stringify(body) });
await post('/_bench/seed', rooms.map((room): SeedProject => ({ id: room.projectId, ownerId: room.users[0], members: room.users.slice(1), data })));

interface ServerHandle {
  root: string;
  child: ChildProcess;
  port: number;
}
const servers: ServerHandle[] = [];
for (const root of ROOTS) {
  const child = fork(path.join(here, 'server.ts'), [], {
    cwd: root,
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, COLLAB_JOIN_ROOT: root, COLLAB_JOIN_APPWRITE: `${fakeUrl}/v1` },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const { port } = await waitFor<{ port: number }>(child, 'ready');
  servers.push({ root, child, port });
}
const restart = async (server: ServerHandle) => {
  const done = waitFor(server.child, 'restarted');
  server.child.send({ type: 'restart' });
  await done;
};
const metricsOf = async (server: ServerHandle) => {
  const answer = waitFor<{ metrics: Record<string, number>; errors: string[] }>(server.child, 'metrics');
  server.child.send({ type: 'metrics' });
  return answer;
};

const clients = rooms.flatMap((room) => room.users.map((user) => new BenchClient(room, user)));
const short = (root: string) => (ROOTS.length > 1 ? `${ROOTS.indexOf(root) === 0 ? 'A' : 'B'} ${path.basename(root)}` : path.basename(root));

console.log(`Banc d'entrée dans une salle — ${ROOMS} salles × ${USERS} éditeurs, document : ${source} (${(Buffer.byteLength(JSON.stringify(document)) / 1e6).toFixed(2)} Mo)`);
console.log(`Appwrite : p50 ${P50} ms / p95 ${P95} ms par appel ; aller-retour client ${RTT_MS} ms ; ${WAVES} vague(s) par version`);

// Mise en route sans latence : premier chargement de chaque salle depuis le document (point de
// sauvegarde initial), avec chaque version — les vagues mesurées partent ensuite de ce point.
for (const server of servers) {
  await Promise.all(clients.map((client) => client.connect(server.port, 'mise-en-route', 'mise-en-route')));
  await Promise.all(clients.map((client) => client.close()));
  await restart(server);
}
await post('/_bench/latency', { p50: P50, p95: P95 });

const serverMetrics = new Map<string, Array<Record<string, number>>>();
const serverErrors: string[] = [];
for (let wave = 0; wave < WAVES; wave += 1) {
  const order = wave % 2 === 0 ? servers : [...servers].reverse();
  for (const server of order) {
    const { root } = server;
    await restart(server);
    // Entrée à froid : salles à recharger.
    await Promise.all(clients.map(async (client) => {
      await sleep(Math.random() * RAMP_MS);
      const ms = await client.connect(server.port, root, 'froid');
      if (ms !== null) record(root, 'welcome.froid', ms);
    }));
    // Modifications.
    const editUntil = Date.now() + EDIT_S * 1000;
    await Promise.all(clients.map(async (client) => {
      while (Date.now() < editUntil) {
        await sleep(between(1_500, 4_000));
        if (Date.now() >= editUntil) break;
        if (Math.random() < 0.35) client.routeEdit();
        else client.smallEdit();
      }
    }));
    await sleep(1_500);
    // Reconnexion, salle chargée.
    await Promise.all(clients.map(async (client) => {
      await sleep(Math.random() * RAMP_MS);
      await client.close();
      const ms = await client.connect(server.port, root, 'chaud');
      if (ms !== null) record(root, 'welcome.chaud', ms);
    }));
    await Promise.all(clients.map((client) => client.close()));
    const { metrics, errors } = await metricsOf(server);
    (serverMetrics.get(root) ?? serverMetrics.set(root, []).get(root)!).push(metrics);
    serverErrors.push(...errors.map((error) => `${short(root)} : ${error}`));
    console.log(`  vague ${wave + 1} · ${short(root)} : welcome froid p50 ${Math.round(percentile(results.get(root)?.['welcome.froid'] ?? [], 0.5))} ms`);
  }
}

// ── Rapport ────────────────────────────────────────────────────────────────
const rows: Array<[string, string, (series: Series) => string]> = [];
const stat = (name: string, unit = 'ms') => (series: Series) => {
  const values = series[name] ?? [];
  if (values.length === 0) return '—';
  const fmt = (value: number) => (unit === 'Ko' ? (value / 1024).toFixed(1) : String(Math.round(value)));
  return `${fmt(percentile(values, 0.5))} / ${fmt(percentile(values, 0.95))} / ${fmt(Math.max(...values))} (${values.length})`;
};
rows.push(['Entrée, salle froide (welcome)', 'p50 / p95 / max ms (n)', stat('welcome.froid')]);
rows.push(['Entrée, salle chargée (welcome)', 'p50 / p95 / max ms (n)', stat('welcome.chaud')]);
rows.push(['Taille du welcome', 'Ko', stat('froid.welcome-octets', 'Ko')]);
rows.push(['Accusé d’un réglage', 'ms', stat('accusé.réglage')]);
rows.push(['Accusé d’un tracé', 'ms', stat('accusé.tracé')]);
rows.push(['Octets de l’accusé d’un tracé', 'Ko', stat('accusé.tracé-octets', 'Ko')]);
rows.push(['Diffusion d’un réglage', 'ms', stat('diffusion.réglage')]);
rows.push(['Diffusion d’un tracé', 'ms', stat('diffusion.tracé')]);
const lines = [
  `# Banc d'entrée dans une salle — ${LABEL}`,
  '',
  `${new Date().toISOString()} · ${ROOMS} salles × ${USERS} éditeurs · ${source} · Appwrite p50 ${P50} / p95 ${P95} ms par appel · aller-retour client ${RTT_MS} ms · ${WAVES} vague(s) par version, entrelacées`,
  '',
  `| Mesure | unité | ${ROOTS.map(short).join(' | ')} |`,
  `|---|---|${ROOTS.map(() => '---').join('|')}|`,
  ...rows.map(([label, unit, cell]) => `| ${label} | ${unit} | ${ROOTS.map((root) => cell(results.get(root) ?? {})).join(' | ')} |`),
  `| Refus / échecs | n | ${ROOTS.map((root) => `${results.get(root)?.refus?.length ?? 0} / ${(results.get(root)?.['froid.échecs']?.length ?? 0) + (results.get(root)?.['chaud.échecs']?.length ?? 0)}`).join(' | ')} |`,
];
const serverKeys = ['entry_auth', 'entry_room_load', 'entry_welcome', 'entry_total'];
const anyServerMetrics = [...serverMetrics.values()].some((list) => list.some((metrics) => 'entry_total_count' in metrics));
if (anyServerMetrics) {
  lines.push('', 'Côté serveur (dernière vague de chaque version, p50 / p95 / max ms) :', '', `| Étape | ${ROOTS.map(short).join(' | ')} |`, `|---|${ROOTS.map(() => '---').join('|')}|`);
  for (const key of serverKeys) {
    lines.push(`| ${key} | ${ROOTS.map((root) => {
      const metrics = serverMetrics.get(root)?.at(-1);
      return metrics && `${key}_p50_ms` in metrics ? `${metrics[`${key}_p50_ms`]} / ${metrics[`${key}_p95_ms`]} / ${metrics[`${key}_max_ms`]}` : '—';
    }).join(' | ')} |`);
  }
}
const stats = await (await fetch(`${fakeUrl}/_bench/stats`)).json() as Record<string, number>;
lines.push('', `Appels au faux Appwrite (toutes versions) : ${Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(' · ')}`);
if (serverErrors.length > 0) lines.push('', `Erreurs du serveur : ${serverErrors.slice(0, 10).join(' ; ')}`);
const report = lines.join('\n');
console.log(`\n${report}`);
const outDir = path.join(repo, 'script-test-bench/reports/collab-join');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${LABEL}.md`), `${report}\n`);
writeFileSync(path.join(outDir, `${LABEL}.json`), JSON.stringify({ roots: ROOTS, results: Object.fromEntries(results), serverMetrics: Object.fromEntries(serverMetrics) }, null, 1));

// Sortie sans `process.exit` immédiat (Windows : assertion de libuv sur un canal IPC en fermeture).
process.exitCode = serverErrors.length > 0 ? 1 : 0;
for (const server of servers) {
  server.child.send({ type: 'stop' });
  server.child.disconnect();
}
fake.disconnect();
setTimeout(() => process.exit(), 3_000).unref();
