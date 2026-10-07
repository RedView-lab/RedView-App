import path from 'node:path';

import { captureServerError, flushServerObservability, initServerObservability } from '../lib/observability.mjs';
import { createAppwriteStorage } from './appwriteStorage.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer } from './server.ts';
import type { RoomStorage } from './storage.ts';

/**
 * Serveur temps réel de co-édition (service Coolify séparé, Dockerfile.multiplayer ;
 * en dev, lancé par scripts/dev/start-dev-services.mjs et servi par Vite sous
 * `/multiplayer`).
 *
 *   MULTIPLAYER_PORT          port d'écoute public (17790 ; /health et WebSocket)
 *   MULTIPLAYER_HOST          interface d'écoute (production : toutes, IPv6 et IPv4, pour le
 *                             port publié par Docker ; sinon 127.0.0.1 — jamais le réseau local
 *                             en dev)
 *   MULTIPLAYER_ALLOWED_ORIGINS  origines de navigateur acceptées, séparées par des virgules
 *                             (production : https://app.redview.tech ; dev : localhost)
 *   MULTIPLAYER_INTERNAL_SECRET  secret partagé avec l'API de partage (≥ 32 car.) : révocation
 *                             immédiate (`POST /internal/access-changed`) ; absent : route fermée
 *   MULTIPLAYER_MAX_CONNECTIONS_PER_IP / _UPGRADES_PER_IP_PER_MINUTE / _CONNECTIONS_PER_USER
 *                             plafonds de connexions (défauts : server.ts ; bancs de charge)
 *   MULTIPLAYER_METRICS_PORT  port interne des mesures (127.0.0.1 ; absent : pas de mesures)
 *   MULTIPLAYER_SHADOW_VALIDATION_MS  validation fantôme d'une salle au plus une fois
 *                             par période (défaut 10 min ; 0 : jamais)
 *   MULTIPLAYER_STORAGE       `appwrite` (production) ou `file` (défaut hors production)
 *   MULTIPLAYER_DATA_DIR      dossier du stockage `file` (.multiplayer-data)
 *   MULTIPLAYER_DEV_AUTH=1    jetons `dev:<utilisateur>`, projets créés par le premier
 *                             client (ignoré quand NODE_ENV=production)
 *   APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY / APPWRITE_DATABASE_ID
 *   SENTRY_DSN_SERVER         erreurs vers GlitchTip (comme le serveur de l'app)
 *
 * GET /health : `{"ok":true}` tant que le serveur accepte des connexions (503
 * pendant l'arrêt). Mesures (port interne) : GET /metrics (texte Prometheus)
 * et /metrics.json — salles, clients, latence du journal, points de
 * sauvegarde, erreurs, validation fantôme, boucle d'événements, mémoire.
 */

/**
 * Appwrite 1.6 renvoie à chaque réponse l'en-tête `x-appwrite-warning` « SDK
 * built for Appwrite 2.0.0 » que node-appwrite affiche : bruit filtré ici
 * (le reste des avertissements passe).
 */
const consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Warning: The current SDK is built for Appwrite')) return;
  consoleWarn(...args);
};

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.MULTIPLAYER_PORT ?? 17790);
const metricsPort = process.env.MULTIPLAYER_METRICS_PORT ? Number(process.env.MULTIPLAYER_METRICS_PORT) : null;
const shadowValidationIntervalMs = process.env.MULTIPLAYER_SHADOW_VALIDATION_MS
  ? Number(process.env.MULTIPLAYER_SHADOW_VALIDATION_MS)
  : undefined;
const storageKind = process.env.MULTIPLAYER_STORAGE ?? (production ? 'appwrite' : 'file');
const devAuth = !production && process.env.MULTIPLAYER_DEV_AUTH === '1';
// Production sans hôte : Node écoute `::` (IPv6 et IPv4), ou `0.0.0.0` sans IPv6.
// Jamais `0.0.0.0` seul : le contrôle de santé de Coolify appelle `localhost`,
// que l'Alpine du conteneur résout en `::1` — refusé, le service restait « unhealthy ».
const listenHost = process.env.MULTIPLAYER_HOST || (production ? undefined : '127.0.0.1');
const allowedOrigins = process.env.MULTIPLAYER_ALLOWED_ORIGINS
  ? process.env.MULTIPLAYER_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : production ? ['https://app.redview.tech'] : [];
const internalSecret = process.env.MULTIPLAYER_INTERNAL_SECRET && process.env.MULTIPLAYER_INTERNAL_SECRET.length >= 32
  ? process.env.MULTIPLAYER_INTERNAL_SECRET
  : undefined;

function limitFromEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
const limits = Object.fromEntries(Object.entries({
  perIp: limitFromEnv('MULTIPLAYER_MAX_CONNECTIONS_PER_IP'),
  upgradesPerIpPerMinute: limitFromEnv('MULTIPLAYER_MAX_UPGRADES_PER_IP_PER_MINUTE'),
  perUser: limitFromEnv('MULTIPLAYER_MAX_CONNECTIONS_PER_USER'),
}).filter(([, value]) => value !== undefined));

const appwrite = process.env.APPWRITE_API_KEY
  ? {
      endpoint: process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'http://127.0.0.1:8082/v1',
      projectId: process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod',
      apiKey: process.env.APPWRITE_API_KEY,
    }
  : null;

function createStorage(): RoomStorage {
  if (storageKind === 'appwrite') {
    if (!appwrite) throw new Error('MULTIPLAYER_STORAGE=appwrite : APPWRITE_API_KEY manquant');
    return createAppwriteStorage({
      ...appwrite,
      databaseId: process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db',
    });
  }
  if (production) throw new Error('stockage `file` refusé en production');
  return createFileStorage(path.resolve(process.env.MULTIPLAYER_DATA_DIR ?? '.multiplayer-data'));
}

initServerObservability();

/** Journal JSON sur la sortie standard ; les erreurs partent aussi vers GlitchTip (sans donnée utilisateur). */
function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'multiplayer', message, ...data });
  if (level === 'error') {
    console.error(line);
    captureServerError(new Error(message), { route: 'multiplayer' });
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

if (process.env.MULTIPLAYER_INTERNAL_SECRET && !internalSecret) {
  log('warn', 'MULTIPLAYER_INTERNAL_SECRET trop court (32 car. minimum) : révocation immédiate désactivée');
}

// Filet de sécurité : une promesse rejetée oubliée est consignée, jamais fatale
// (le processus tient toutes les salles ; chaque salle isole déjà ses erreurs).
process.on('unhandledRejection', (reason: unknown) => {
  log('error', 'promesse rejetée non traitée', { error: String(reason) });
});

const storage = createStorage();
const server = createMultiplayerServer({
  storage,
  appwrite,
  devAuth,
  allowedOrigins,
  limits,
  internalSecret,
  host: { log, shadowValidationIntervalMs },
});

server.listen(port, listenHost).then((actual) => {
  log('info', 'serveur temps réel prêt', { port: actual, host: listenHost ?? '::', storage: storage.kind, devAuth, internalRoute: Boolean(internalSecret) });
}, (error: unknown) => {
  log('error', 'écoute impossible', { port, error: String(error) });
  process.exit(1);
});

if (metricsPort !== null) {
  server.listenMetrics(metricsPort).then((actual) => {
    log('info', 'mesures servies sur le port interne', { port: actual });
  }, (error: unknown) => {
    // Sans mesures, le service reste utile : on le signale seulement.
    log('warn', 'port des mesures indisponible', { port: metricsPort, error: String(error) });
  });
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'arrêt demandé', { signal });
  setTimeout(() => process.exit(0), 10_000).unref();
  // Journal écrit, puis connexions fermées (1012) : les clients se reconnectent
  // au serveur suivant et renvoient ce qui n'était pas acquitté.
  await server.shutdown();
  await flushServerObservability();
  process.exit(0);
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
