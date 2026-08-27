/**
 * RedView Local Dev Services Launcher
 *
 * Automatically checks, starts, and monitors:
 * 1. BRouter Standalone Server (port 17777)
 * 2. RedView POI Server (port 17778)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const spawnedProcesses = [];

// Helper to check if a TCP port is open
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

// Wait for a port to start listening
export async function waitForPort(port, maxWaitMs = 15000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Find folder candidates across possible directory structures
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
      POI_HOST: '0.0.0.0',
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

export async function startDevServices() {
  console.log('\n\x1b[1m\x1b[35m=== Démarrage des Services Locaux RedView ===\x1b[0m');
  await Promise.all([ensureBrouterStarted(), ensurePoiServerStarted()]);
  console.log('\x1b[1m\x1b[35m=============================================\x1b[0m\n');
}

// If executed directly: node scripts/start-dev-services.mjs
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

