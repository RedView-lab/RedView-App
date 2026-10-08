/**
 * Banc de charge du VPS de production — combien d'utilisateurs simultanés
 * avant que l'expérience se dégrade ?
 *
 *   npx tsx --env-file=.env script-test-bench/vps-load/run.ts [--steps 1,10,20,50,100]
 *        [--hold 240] [--ramp 30] [--waves 3] [--wave-gap 40] [--workers 5]
 *        [--cold-share 0.25] [--api-per-minute 108] [--payload actuelle|compacte]
 *        [--no-burst] [--label <nom>] [--setup-only]
 *
 * Chaque palier : une session réaliste (arrivées étalées sur `--ramp`, puis
 * `--hold` secondes de visites — vu.ts), puis une rafale (`--waves` vagues
 * où tous font le même geste lourd au même instant). Les utilisateurs
 * virtuels sont de vrais comptes de production (`loadtest-NNN`, accounts.ts)
 * sur des projets faits par l'app (fixtures.ts) ; les comptes 001 à 090 se
 * répartissent en salles de co-édition de 3 (blocs x1–x3 de chaque dizaine,
 * 9 salles au plus : la limite de 32 connexions temps réel par IP de nginx).
 *
 * Limite par IP de l'API (/api/* : 120 requêtes/min dans server.mjs) : tout
 * le générateur partage l'IP du portable. Sans jeton de banc, les gestes
 * d'API au-delà de `--api-per-minute` sont SAUTÉS (comptés à part), jamais
 * retardés : la charge d'API des grands paliers est alors sous-estimée et le
 * rapport le dit.
 *
 * Garde-fous (arrêt immédiat du palier et des suivants) : RAM disponible du
 * VPS < 1,5 Go, disque libre < 10 Go, ou plus de 50 % d'erreurs sur 20 s.
 * Rapport : script-test-bench/reports/vps-load/<date>-<label>/{rapport.md,resultats.json}.
 * Les comptes restent pour les passes suivantes : `accounts.ts teardown` à la fin.
 */
import { execFileSync, execSync, fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessions, deleteSessions, ensureAccounts, type LoadTestSession } from './accounts.ts';
import { loadFixturePayloads, prepareFixtures, type FixturePlan } from './fixtures.ts';
import { sleep, type Sample } from './lib.ts';
import { measureLink, type LinkCapacity } from './link.ts';
import { buildPhaseResult, renderMarkdown, verdicts, type GeneratorHealth, type PhaseResult, type RunMeta, type ServerRoutes } from './report.ts';
import { startSampler, summarizeWindow } from './sampler.ts';
import type { WorkerInit, WorkerPhase } from './worker.ts';

const here = import.meta.dirname;
const ROOT = path.resolve(here, '..', '..');
const REPORT_ROOT = path.join(ROOT, 'script-test-bench', 'reports', 'vps-load');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const APP_URL = process.env.RV_APP_URL ?? 'https://app.redview.tech';
const STEPS = arg('steps', '1,10,20,50,100').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const HOLD_MS = Number(arg('hold', '240')) * 1000;
const RAMP_MS = Number(arg('ramp', '30')) * 1000;
const WAVES = Number(arg('waves', '3'));
const WAVE_GAP_MS = Number(arg('wave-gap', '40')) * 1000;
const COOL_MS = Number(arg('cool', '30')) * 1000;
const WORKERS = Number(arg('workers', '5'));
const COLD_SHARE = Number(arg('cold-share', '0.25'));
const API_PER_MINUTE = Number(arg('api-per-minute', '108'));
const PAYLOAD = arg('payload', 'actuelle') as WorkerInit['payloadVariant'];
const LABEL = arg('label', 'passe');
const MAX_VUS = Math.max(...STEPS);
const ROOM_SIZE = 3;
const MAX_ROOMS = 9;

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function powerState(): string {
  try {
    const status = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Battery).BatteryStatus"', { encoding: 'utf8' }).trim();
    return status === '1' ? 'batterie' : status === '2' ? 'secteur' : `inconnu (${status})`;
  } catch {
    return 'inconnu';
  }
}

/** Ressources d'un premier passage : celles du relevé de calibrage encore servies (un déploiement change les noms hachés). */
async function coldAssetList(): Promise<string[]> {
  const files = readdirSync(REPORT_ROOT).filter((name) => /^calibration-.*\.json$/.test(name)).sort();
  if (!files.length) throw new Error('aucun relevé de calibrage : lancer calibrate.mjs');
  const calibration = JSON.parse(readFileSync(path.join(REPORT_ROOT, files[files.length - 1]!), 'utf8')) as { requests: Array<{ segment: string; method: string; host: string; path: string }> };
  const wanted = [...new Set(calibration.requests
    .filter((r) => r.segment === 'premiere-visite-connexion' && r.method === 'GET' && r.host === new URL(APP_URL).host)
    .map((r) => r.path)
    .filter((p) => p !== '/' && !p.startsWith('/api/') && !p.startsWith('/s/') && !p.startsWith('/multiplayer')))];
  const alive: string[] = [];
  await Promise.all(wanted.map(async (assetPath) => {
    const response = await fetch(`${APP_URL}${assetPath}`, { method: 'HEAD' }).catch(() => null);
    if (response?.ok) alive.push(assetPath);
  }));
  if (alive.length < wanted.length * 0.8) throw new Error(`relevé de calibrage périmé (${alive.length}/${wanted.length} ressources encore servies) : relancer calibrate.mjs`);
  return alive.sort();
}

const SSH_ARGS = ['-i', path.join(os.homedir(), '.ssh', 'oracle_brouter.key'), '-o', 'ConnectTimeout=15', 'opc@141.145.220.99'];
const APP_CONTAINER = 'q7lznj8fhunybhvuvm3jcu0u';

/**
 * Durées vues par le serveur de l'app sur une fenêtre : ses journaux pino
 * (une ligne par requête : route normalisée, statut, `responseTime`), lus en
 * lecture seule. Les ressources statiques ne sont journalisées qu'en debug.
 */
function serverRoutes(from: number, to: number): ServerRoutes | undefined {
  try {
    const since = new Date(from).toISOString();
    const until = new Date(to).toISOString();
    const out = execFileSync('ssh', [...SSH_ARGS, `sudo docker logs --since ${since} --until ${until} $(sudo docker ps -q -f name=${APP_CONTAINER} | head -n1) 2>&1 | grep '"request completed"'`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const byRoute = new Map<string, { times: number[]; statuses: Record<string, number> }>();
    for (const line of out.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line) as { req?: { method?: string }; res?: { statusCode?: number }; responseTime?: number; route?: string };
        const key = `${entry.req?.method ?? '?'} ${entry.route ?? '?'}`;
        const bucket = byRoute.get(key) ?? { times: [], statuses: {} };
        if (typeof entry.responseTime === 'number') bucket.times.push(entry.responseTime);
        const status = String(entry.res?.statusCode ?? '?');
        bucket.statuses[status] = (bucket.statuses[status] ?? 0) + 1;
        byRoute.set(key, bucket);
      } catch {
        /* ligne coupée */
      }
    }
    const routes: ServerRoutes = {};
    for (const [key, bucket] of byRoute) {
      const sorted = bucket.times.sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
      routes[key] = { n: sorted.length, p50: at(0.5), p95: at(0.95), statuses: bucket.statuses };
    }
    return routes;
  } catch (error) {
    log(`journaux de l'app illisibles : ${String((error as Error).message).slice(0, 120)}`);
    return undefined;
  }
}

function mergeGenerators(list: GeneratorHealth[]): GeneratorHealth | undefined {
  if (!list.length) return undefined;
  return {
    loopP99Ms: Math.max(...list.map((g) => g.loopP99Ms)),
    loopMaxMs: Math.max(...list.map((g) => g.loopMaxMs)),
    cpuCores: list.reduce((sum, g) => sum + g.cpuCores, 0),
    upMbps: list.reduce((sum, g) => sum + g.upMbps, 0),
    downMbps: list.reduce((sum, g) => sum + g.downMbps, 0),
  };
}

function collabIndexes(): number[] {
  const out: number[] = [];
  for (let room = 0; room < MAX_ROOMS; room += 1) {
    const block = [room * 10 + 1, room * 10 + 2, room * 10 + 3].filter((index) => index <= MAX_VUS);
    if (block.length >= 2) out.push(...block);
  }
  return out;
}

interface WorkerHandle {
  child: ChildProcess;
  indexes: number[];
  send(message: unknown): void;
  waitFor<T = Record<string, unknown>>(type: string): Promise<T>;
}

function spawnWorker(onHealth: (ok: number, err: number) => void): WorkerHandle {
  const child = fork(path.join(here, 'worker.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  const waiters = new Map<string, Array<(message: Record<string, unknown>) => void>>();
  child.on('message', (message: Record<string, unknown>) => {
    if (message.type === 'health') onHealth(Number(message.ok), Number(message.err));
    else if (message.type === 'fatal') log(`processus de travail : ${String(message.error)}`);
    const list = waiters.get(String(message.type));
    const next = list?.shift();
    if (next) next(message);
  });
  return {
    child,
    indexes: [],
    send: (message) => child.send(message as never),
    waitFor: <T,>(type: string) => new Promise<T>((resolve) => {
      const list = waiters.get(type) ?? [];
      list.push(resolve as (message: Record<string, unknown>) => void);
      waiters.set(type, list);
    }),
  };
}

async function main(): Promise<void> {
  if (!process.env.APPWRITE_API_KEY) throw new Error('APPWRITE_API_KEY manquant (lancer avec --env-file=.env)');
  const startedAt = new Date();
  const outDir = path.join(REPORT_ROOT, `${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 16)}-${LABEL}`);
  mkdirSync(outDir, { recursive: true });
  const power = powerState();
  log(`paliers ${STEPS.join(' → ')}, ${WORKERS} processus, alimentation : ${power}`);

  const sampler = startSampler(log);
  for (let wait = 0; wait < 30 && sampler.samples.length < 2; wait += 1) await sleep(1_000);
  const first = sampler.latest();
  if (!first) throw new Error('relevé du VPS indisponible (SSH)');
  if (first.diskFree < 10e9) throw new Error(`disque du VPS trop plein (${(first.diskFree / 1e9).toFixed(1)} Go libres < 10)`);
  if (first.memAvailKb < 3 * 1024 * 1024) throw new Error(`RAM disponible du VPS trop basse (${(first.memAvailKb / 1048576).toFixed(1)} Go)`);

  const accounts = await ensureAccounts(MAX_VUS + 1);
  const sessions = await createSessions(accounts.filter((account) => account.index >= 1));
  const [probe] = await createSessions(accounts.filter((account) => account.index === 0));
  log(`${sessions.length} sessions ouvertes`);
  let link: LinkCapacity | null = null;
  const results: PhaseResult[] = [];
  const workers: WorkerHandle[] = [];
  const notes: string[] = [];
  let idle = null as ReturnType<typeof summarizeWindow>;
  try {
    const payloads = loadFixturePayloads(PAYLOAD);
    log(`charges : petit ${payloads.petit.data.length}, moyen ${payloads.moyen.data.length}, gros ${payloads.gros.data.length} caractères (${PAYLOAD})`);
    const plan: FixturePlan = await prepareFixtures(sessions, loadFixturePayloads('actuelle'), collabIndexes(), ROOM_SIZE, log);
    if (flag('setup-only')) return;
    const coldAssets = await coldAssetList();
    log(`premier passage : ${coldAssets.length} ressources`);
    link = await measureLink(APP_URL, coldAssets, probe!, payloads.gros.data, process.env.VITE_APPWRITE_ENDPOINT ?? 'https://appwrite.redview.tech/v1', process.env.VITE_APPWRITE_PROJECT_ID ?? 'redview-prod');
    log(`lien du générateur : ↓ ${link.downMbps.toFixed(0)} Mbit/s, ↑ ${link.upMbps.toFixed(0)} Mbit/s, aller-retour ${link.rttMs.toFixed(0)} ms`);

    // Répartition : chaque salle entière dans un processus, les autres en tourniquet.
    let windowOk = 0;
    let windowErr = 0;
    for (let index = 0; index < WORKERS; index += 1) workers.push(spawnWorker((ok, err) => {
      windowOk += ok;
      windowErr += err;
    }));
    const roomOf = new Map<number, (typeof plan.rooms)[number]>();
    plan.rooms.forEach((room, roomIndex) => {
      for (const member of room.memberIndexes) {
        roomOf.set(member, room);
        workers[roomIndex % WORKERS]!.indexes.push(member);
      }
    });
    let cursor = 0;
    for (const session of sessions) {
      if (roomOf.has(session.index)) continue;
      workers[cursor % WORKERS]!.indexes.push(session.index);
      cursor += 1;
    }
    const byIndex = new Map(sessions.map((session) => [session.index, session]));
    await Promise.all(workers.map(async (worker) => {
      const init: WorkerInit = {
        type: 'init',
        appUrl: APP_URL,
        appwriteEndpoint: process.env.VITE_APPWRITE_ENDPOINT ?? 'https://appwrite.redview.tech/v1',
        appwriteProject: process.env.VITE_APPWRITE_PROJECT_ID ?? 'redview-prod',
        coldAssets,
        coldShare: COLD_SHARE,
        apiPerMinute: API_PER_MINUTE / WORKERS,
        payloadVariant: PAYLOAD,
        vus: worker.indexes.sort((a, b) => a - b).map((index, localIndex) => ({
          session: byIndex.get(index)! as LoadTestSession,
          own: plan.own[index]!,
          room: roomOf.get(index) ?? null,
          configIndex: localIndex,
        })),
      };
      worker.send(init);
      const ready = await worker.waitFor<{ vus: number; configs: number }>('ready');
      log(`processus prêt : ${ready.vus} utilisateurs (${ready.configs} réglages de tracé)`);
    }));

    log('référence : VPS au repos 30 s');
    const idleFrom = Date.now();
    await sleep(30_000);
    idle = summarizeWindow(sampler.samples, idleFrom, Date.now());

    let stopReason: string | null = null;
    const guard = (): string | null => {
      const latest = sampler.latest();
      if (latest && latest.memAvailKb < 1.5 * 1024 * 1024) return `RAM disponible du VPS ${(latest.memAvailKb / 1048576).toFixed(1)} Go`;
      if (latest && latest.diskFree < 10e9) return `disque libre ${(latest.diskFree / 1e9).toFixed(1)} Go`;
      return null;
    };
    const runPhase = async (step: number, phase: WorkerPhase['phase']): Promise<void> => {
      const active = new Set(sessions.filter((session) => session.index <= step).map((session) => session.index));
      const startAt = Date.now() + 2_000;
      const endAt = phase === 'realiste' ? startAt + RAMP_MS + HOLD_MS : startAt + 15_000 + WAVES * WAVE_GAP_MS;
      const waves = phase === 'rafale' ? Array.from({ length: WAVES }, (_, wave) => startAt + 15_000 + wave * WAVE_GAP_MS) : [];
      windowOk = 0;
      windowErr = 0;
      const done = workers.map((worker) => worker.waitFor<{ samples: Sample[]; generator?: GeneratorHealth }>('phase-done'));
      for (const [workerIndex, worker] of workers.entries()) {
        worker.send({
          type: 'phase', phase, active: worker.indexes.filter((index) => active.has(index)),
          startAt, endAt, rampMs: RAMP_MS, waves, seed: step * 1000 + workerIndex + (phase === 'rafale' ? 500 : 0),
        } satisfies WorkerPhase);
      }
      log(`palier ${step} — ${phase} (${active.size} utilisateurs) jusqu'à ${new Date(endAt).toISOString().slice(11, 19)}`);
      let aborted: string | undefined;
      const errorWindow: Array<[number, number]> = [];
      const watcher = setInterval(() => {
        errorWindow.push([windowOk, windowErr]);
        windowOk = 0;
        windowErr = 0;
        if (errorWindow.length > 4) errorWindow.shift();
        const ok = errorWindow.reduce((sum, [value]) => sum + value, 0);
        const err = errorWindow.reduce((sum, [, value]) => sum + value, 0);
        const reason = guard() ?? (err >= 20 && err > ok ? `${err} erreurs pour ${ok} réussites sur 20 s` : null);
        if (reason && !aborted) {
          aborted = reason;
          log(`ARRÊT : ${reason}`);
          for (const worker of workers) worker.send({ type: 'abort' });
        }
      }, 5_000);
      const messages = await Promise.all(done);
      const phaseSamples = messages.flatMap((message) => message.samples);
      clearInterval(watcher);
      const endedAt = Date.now();
      const result = buildPhaseResult(step, phase, startAt, endedAt, phaseSamples, summarizeWindow(sampler.samples, startAt, endedAt), {
        aborted,
        generator: mergeGenerators(messages.flatMap((message) => (message.generator ? [message.generator] : []))),
        server: serverRoutes(startAt, endedAt),
      });
      results.push(result);
      const baseline = results.find((r) => r.phase === 'realiste' && r.step === STEPS[0]) ?? null;
      const found = verdicts(result, phase === 'realiste' ? baseline : null);
      const g = result.generator;
      log(`  ${phaseSamples.length} mesures ; VPS CPU moy ${result.vps?.cpuAvg.toFixed(0) ?? '—'} % max ${result.vps?.cpuMax.toFixed(0) ?? '—'} % ; générateur boucle p99 ${g?.loopP99Ms.toFixed(0) ?? '—'} ms, ↑${g?.upMbps.toFixed(1) ?? '—'} ↓${g?.downMbps.toFixed(1) ?? '—'} Mbit/s ; ${found.length ? `dégradé : ${found.map((v) => v.name).join(', ')}` : 'dans les seuils'}`);
      writeFileSync(path.join(outDir, 'resultats.json'), JSON.stringify({ results, idle }, null, 1));
      if (aborted) stopReason = aborted;
    };

    for (const step of STEPS) {
      await runPhase(step, 'realiste');
      if (!stopReason && !flag('no-burst')) await runPhase(step, 'rafale');
      await Promise.all(workers.map((worker) => {
        worker.send({ type: 'close-collab' });
        return worker.waitFor('collab-closed');
      }));
      if (stopReason) {
        notes.push(`Passe arrêtée au palier ${step} : ${stopReason}.`);
        break;
      }
      if (step !== STEPS[STEPS.length - 1]) {
        log(`refroidissement ${COOL_MS / 1000} s`);
        await sleep(COOL_MS);
      }
    }
  } finally {
    for (const worker of workers) worker.send({ type: 'shutdown' });
    await deleteSessions([...sessions, ...(probe ? [probe] : [])]).catch(() => undefined);
    sampler.stop();
    const meta: RunMeta = {
      label: LABEL,
      waves: WAVES,
      startedAt: startedAt.toISOString(),
      appUrl: APP_URL,
      steps: STEPS,
      holdS: HOLD_MS / 1000,
      apiPerMinute: API_PER_MINUTE,
      payloadVariant: PAYLOAD,
      link,
      power,
      gitHead: (() => {
        try {
          return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
        } catch {
          return '?';
        }
      })(),
      notes,
    };
    if (results.length) {
      writeFileSync(path.join(outDir, 'resultats.json'), JSON.stringify({ meta, results, idle, vpsSamples: sampler.samples }, null, 1));
      writeFileSync(path.join(outDir, 'rapport.md'), renderMarkdown(meta, results, idle));
      log(`rapport : ${path.relative(ROOT, path.join(outDir, 'rapport.md'))}`);
    }
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
