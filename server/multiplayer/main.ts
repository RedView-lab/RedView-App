import path from 'node:path';

import { createAppwriteStorage } from './appwriteStorage.ts';
import { createFileStorage } from './fileStorage.ts';
import { createMultiplayerServer } from './server.ts';
import type { RoomStorage } from './storage.ts';

/**
 * Serveur temps réel de co-édition (service Coolify séparé, Dockerfile.multiplayer ;
 * en dev, lancé par scripts/start-dev-services.mjs et servi par Vite sous
 * `/multiplayer`).
 *
 *   MULTIPLAYER_PORT          port d'écoute (17790)
 *   MULTIPLAYER_STORAGE       `appwrite` (production) ou `file` (défaut hors production)
 *   MULTIPLAYER_DATA_DIR      dossier du stockage `file` (.multiplayer-data)
 *   MULTIPLAYER_DEV_AUTH=1    jetons `dev:<utilisateur>`, projets créés par le premier
 *                             client (ignoré quand NODE_ENV=production)
 *   APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY / APPWRITE_DATABASE_ID
 *
 * GET /health : 200 tant que le serveur accepte des connexions (503 pendant
 * l'arrêt) ; GET /metrics : salles, clients, retard du journal, points de
 * sauvegarde (texte Prometheus).
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
const storageKind = process.env.MULTIPLAYER_STORAGE ?? (production ? 'appwrite' : 'file');
const devAuth = !production && process.env.MULTIPLAYER_DEV_AUTH === '1';

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

const storage = createStorage();
const server = createMultiplayerServer({ storage, appwrite, devAuth });

server.listen(port).then((actual) => {
  server.host.log('info', 'serveur temps réel prêt', { port: actual, storage: storage.kind, devAuth });
}, (error: unknown) => {
  server.host.log('error', 'écoute impossible', { port, error: String(error) });
  process.exit(1);
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.host.log('info', 'arrêt demandé', { signal });
  setTimeout(() => process.exit(0), 10_000).unref();
  // Journal écrit, puis connexions fermées (1012) : les clients se reconnectent
  // au serveur suivant et renvoient ce qui n'était pas acquitté.
  await server.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
