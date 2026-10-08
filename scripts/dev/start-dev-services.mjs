/**
 * Lanceur des services de développement locaux de RedView
 *
 * Vérifie, démarre et surveille automatiquement :
 * 1. le serveur BRouter autonome (port 17777)
 * 2. le serveur de POI RedView (port 17778)
 * 2b. le serveur temps réel de co-édition (port 17790, server/multiplayer :
 *     stockage de fichiers .multiplayer-data/, authentification de dev ; Vite
 *     le sert sous /multiplayer)
 * 3. le tunnel SSH vers le nginx du VPS quand les upstreams du .env pointent
 *    dessus (`startVpsTunnel` / `applyVpsTunnel`, utilisés par l'API de dev de
 *    Vite)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

const spawnedProcesses = [];

// Aide : vérifie si un port TCP est ouvert
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isConnected = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      isConnected = true;
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(port, host);
  });
}

// Attend qu'un port se mette à écouter
export async function waitForPort(port, maxWaitMs = 15000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Cherche les dossiers candidats parmi les structures de répertoires possibles
function findDir(relativeCandidates) {
  for (const rel of relativeCandidates) {
    const p = path.resolve(rootDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function ensureBrouterStarted() {
  const BROUTER_PORT = 17777;
  const isRunning = await isPortOpen(BROUTER_PORT);
  if (isRunning) {
    console.log(`\x1b[32m[BROUTER]\x1b[0m Serveur BRouter actif sur \x1b[1mhttp://localhost:${BROUTER_PORT}\x1b[0m`);
    return null;
  }

  const brouterDir = findDir(['../redview-brouter', '../../redview-brouter', 'vendor/redview-brouter']);
  if (!brouterDir) {
    console.warn(`\x1b[33m[BROUTER]\x1b[0m Dossier redview-brouter introuvable.`);
    return null;
  }

  const jarPath = path.resolve(brouterDir, 'brouter-server.jar');
  const segmentsDir = path.resolve(brouterDir, 'segments4');
  const profilesDir = path.resolve(brouterDir, 'profiles');
  const customProfilesDir = path.resolve(profilesDir, 'customprofiles');

  if (!fs.existsSync(jarPath)) {
    console.warn(`\x1b[33m[BROUTER]\x1b[0m brouter-server.jar introuvable dans ${brouterDir}`);
    return null;
  }

  if (!fs.existsSync(customProfilesDir)) {
    fs.mkdirSync(customProfilesDir, { recursive: true });
  }

  console.log(`\x1b[36m[BROUTER]\x1b[0m Démarrage de BRouter (port ${BROUTER_PORT})...`);

  const child = spawn('java', [
    '-Xms1G',
    '-Xmx6G',
    '-XX:+UseG1GC',
    '-cp',
    jarPath,
    'btools.server.RouteServer',
    segmentsDir,
    profilesDir,
    'customprofiles',
    String(BROUTER_PORT),
    '8',
  ], {
    cwd: brouterDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  if (child) {
    child.unref();
  }

  const ready = await waitForPort(BROUTER_PORT, 15000);
  if (ready) {
    console.log(`\x1b[32m[BROUTER]\x1b[0m Serveur BRouter prêt sur \x1b[1mhttp://localhost:${BROUTER_PORT}\x1b[0m`);
  } else {
    console.warn(`\x1b[31m[BROUTER]\x1b[0m BRouter lancé mais port ${BROUTER_PORT} non détecté après 15s.`);
  }

  return child;
}

export async function ensurePoiServerStarted() {
  const POI_PORT = 17778;
  const isRunning = await isPortOpen(POI_PORT);
  if (isRunning) {
    console.log(`\x1b[32m[POI]\x1b[0m Serveur POI actif sur \x1b[1mhttp://localhost:${POI_PORT}\x1b[0m`);
    return null;
  }

  const poiDir = findDir(['../redview-poi-server', '../../redview-poi-server', 'vendor/redview-poi-server']);
  if (!poiDir) {
    console.warn(`\x1b[33m[POI]\x1b[0m Dossier redview-poi-server introuvable.`);
    return null;
  }

  const serverFile = path.resolve(poiDir, 'server.js');
  if (!fs.existsSync(serverFile)) {
    console.warn(`\x1b[33m[POI]\x1b[0m server.js introuvable dans ${poiDir}`);
    return null;
  }

  console.log(`\x1b[36m[POI]\x1b[0m Démarrage du serveur POI (port ${POI_PORT})...`);

  const child = spawn('node', ['server.js'], {
    cwd: poiDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      POI_PORT: String(POI_PORT),
      // Boucle locale : seul le proxy `api/poi.ts` (même machine) l'appelle.
      POI_HOST: '127.0.0.1',
    },
  });

  if (child) {
    child.unref();
  }

  const ready = await waitForPort(POI_PORT, 10000);
  if (ready) {
    console.log(`\x1b[32m[POI]\x1b[0m Serveur POI prêt sur \x1b[1mhttp://localhost:${POI_PORT}\x1b[0m`);
  } else {
    console.warn(`\x1b[31m[POI]\x1b[0m Serveur POI lancé mais port ${POI_PORT} non détecté après 10s.`);
  }

  return child;
}

/* ------------------------------------------------------------------ */
/* Tunnel SSH vers le VPS (dev)                                        */
/* ------------------------------------------------------------------ */

/**
 * Le nginx du VPS n'accepte /brouter, /poi/, /weather/ et /openmeteo/ que depuis le VPS
 * lui-même (server/weather-daemon/brouter.conf) : depuis un poste de dev, les
 * amonts du .env répondent 403. En dev, un tunnel SSH vers son port 80 fait
 * arriver ces requêtes depuis 127.0.0.1, comme celles de l'app en prod.
 *
 *   REDVIEW_DEV_TUNNEL=0        désactive le tunnel
 *   REDVIEW_DEV_SSH_KEY=<path>  clé (défaut ~/.ssh/oracle_brouter.key)
 *   REDVIEW_DEV_SSH_USER=<user> utilisateur (défaut opc)
 *   REDVIEW_DEV_TUNNEL_PORT=<n> port local (défaut 18080)
 */
const VPS_UPSTREAM_KEYS = ['BROUTER_UPSTREAM', 'POI_UPSTREAM', 'WEATHER_UPSTREAM', 'OPENMETEO_UPSTREAM'];

/** @type {{ host: string, port: number, ready: Promise<boolean>, active: boolean } | null} */
let vpsTunnel = null;
/** Après un échec, pas de nouvel essai avant cette date (chaque requête /api attendrait ssh). */
let vpsTunnelRetryAt = 0;
const VPS_TUNNEL_RETRY_DELAY_MS = 60_000;

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/** URL d'amont servie par le nginx du VPS (http, port 80, hôte distant), sinon null. */
function parseVpsUpstream(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || (url.port !== '' && url.port !== '80') || isLocalHostname(url.hostname)) return null;
  return url;
}

/** Messages de ssh utiles à l'utilisateur (sans l'avertissement post-quantique). */
function sshErrorSummary(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('**'))
    .join(' ')
    .slice(0, 300);
}

/**
 * Ouvre (ou réutilise) le tunnel vers le nginx du VPS désigné par les amonts
 * de `env`. Résout `true` quand il est prêt. Un tunnel tombé est rouvert au
 * prochain appel.
 */
export function startVpsTunnel(env = process.env) {
  if (vpsTunnel) return vpsTunnel.ready;
  if (env.REDVIEW_DEV_TUNNEL === '0' || Date.now() < vpsTunnelRetryAt) return Promise.resolve(false);
  const host = VPS_UPSTREAM_KEYS.map((key) => parseVpsUpstream(env[key])?.hostname).find(Boolean);
  if (!host) return Promise.resolve(false);

  const keyPath = env.REDVIEW_DEV_SSH_KEY || path.join(os.homedir(), '.ssh', 'oracle_brouter.key');
  if (!fs.existsSync(keyPath)) {
    console.warn(`\x1b[33m[VPS]\x1b[0m Clé SSH introuvable (${keyPath}) : BRouter / POI / météo du VPS répondront 403 en local.`);
    vpsTunnelRetryAt = Number.POSITIVE_INFINITY;
    return Promise.resolve(false);
  }
  const user = env.REDVIEW_DEV_SSH_USER || 'opc';
  const port = Number(env.REDVIEW_DEV_TUNNEL_PORT) || 18080;

  const tunnel = { host, port, ready: Promise.resolve(false), active: false };
  vpsTunnel = tunnel;
  tunnel.ready = (async () => {
    if (await isPortOpen(port)) {
      console.log(`\x1b[32m[VPS]\x1b[0m Tunnel déjà ouvert sur \x1b[1mhttp://127.0.0.1:${port}\x1b[0m`);
      return true;
    }
    console.log(`\x1b[36m[VPS]\x1b[0m Ouverture du tunnel SSH vers ${host} (port local ${port})...`);
    const child = spawn('ssh', [
      '-i', keyPath,
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${port}:127.0.0.1:80`,
      `${user}@${host}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise((resolve) => {
      child.once('error', (error) => {
        stderr += String(error?.message ?? error);
        resolve(false);
      });
      child.once('exit', () => resolve(false));
    });
    // Tunnel tombé (veille, réseau) : rouvert à la prochaine requête /api.
    child.once('exit', (code) => {
      if (vpsTunnel === tunnel) vpsTunnel = null;
      if (tunnel.active) console.warn(`\x1b[33m[VPS]\x1b[0m Tunnel fermé (code ${code}), réouverture à la prochaine requête.`);
    });
    const stop = () => child.kill();
    process.once('exit', stop);
    child.once('exit', () => process.off('exit', stop));

    const ok = await Promise.race([waitForPort(port, 15000, 250), exited]);
    if (ok) {
      console.log(`\x1b[32m[VPS]\x1b[0m Tunnel prêt : BRouter / POI / météo via \x1b[1mhttp://127.0.0.1:${port}\x1b[0m`);
    } else {
      child.kill();
      console.warn(`\x1b[31m[VPS]\x1b[0m Tunnel SSH impossible${stderr ? ` : ${sshErrorSummary(stderr)}` : ''}. Les amonts du VPS répondront 403 en local.`);
    }
    return ok;
  })();
  tunnel.ready.then((ok) => {
    tunnel.active = ok;
    if (ok) return;
    if (vpsTunnel === tunnel) vpsTunnel = null;
    vpsTunnelRetryAt = Date.now() + VPS_TUNNEL_RETRY_DELAY_MS;
  });
  return tunnel.ready;
}

/** Dirige les amonts du VPS de `env` vers le tunnel, s'il est ouvert. */
export function applyVpsTunnel(env = process.env) {
  if (!vpsTunnel?.active) return;
  for (const key of VPS_UPSTREAM_KEYS) {
    const url = parseVpsUpstream(env[key]);
    if (!url || url.hostname !== vpsTunnel.host) continue;
    env[key] = `http://127.0.0.1:${vpsTunnel.port}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  }
}

/** Surchargeable (REDVIEW_MULTIPLAYER_DEV_PORT) : un second serveur de dev garde son propre serveur temps réel. */
export const MULTIPLAYER_DEV_PORT = Number(process.env.REDVIEW_MULTIPLAYER_DEV_PORT ?? 17790);

export async function ensureMultiplayerStarted() {
  if (await isPortOpen(MULTIPLAYER_DEV_PORT)) {
    console.log(`\x1b[32m[MULTIPLAYER]\x1b[0m Serveur temps réel actif sur \x1b[1mws://localhost:${MULTIPLAYER_DEV_PORT}\x1b[0m (npm run services:stop pour le relancer après une modification)`);
    return null;
  }
  // Un second serveur temps réel (port surchargé) a ses propres salles.
  const dataDir = path.resolve(rootDir, MULTIPLAYER_DEV_PORT === 17790 ? '.multiplayer-data' : `.multiplayer-data-${MULTIPLAYER_DEV_PORT}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  console.log(`\x1b[36m[MULTIPLAYER]\x1b[0m Démarrage du serveur temps réel (port ${MULTIPLAYER_DEV_PORT})...`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/multiplayer/main.ts'], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MULTIPLAYER_PORT: String(MULTIPLAYER_DEV_PORT),
      MULTIPLAYER_STORAGE: 'file',
      MULTIPLAYER_DATA_DIR: dataDir,
      MULTIPLAYER_DEV_AUTH: '1',
    },
  });
  child.unref();
  const ready = await waitForPort(MULTIPLAYER_DEV_PORT, 15000);
  if (ready) {
    console.log(`\x1b[32m[MULTIPLAYER]\x1b[0m Serveur temps réel prêt (journal : .multiplayer-data/server.log)`);
  } else {
    console.warn(`\x1b[31m[MULTIPLAYER]\x1b[0m Port ${MULTIPLAYER_DEV_PORT} non détecté après 15 s (voir .multiplayer-data/server.log).`);
  }
  return child;
}

export async function startDevServices() {
  console.log('\n\x1b[1m\x1b[35m=== Démarrage des Services Locaux RedView ===\x1b[0m');
  await Promise.all([ensureBrouterStarted(), ensurePoiServerStarted(), ensureMultiplayerStarted()]);
  console.log('\x1b[1m\x1b[35m=============================================\x1b[0m\n');
}

// Exécuté directement : node scripts/dev/start-dev-services.mjs
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startDevServices()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Erreur lors du démarrage des services:', err);
      process.exit(1);
    });
}

