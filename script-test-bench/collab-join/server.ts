/**
 * Serveur temps réel du banc d'entrée dans une salle (processus enfant de
 * run.ts, lancé dans le dossier `COLLAB_JOIN_ROOT` : arbre de travail, ou
 * copie d'un autre commit pour un A/B) : le vrai serveur, avec le vrai
 * stockage Appwrite (appwriteStorage.ts) et la vraie vérification des jetons
 * et des droits (auth.ts), contre le faux Appwrite de fakeAppwrite.ts.
 * Pilotage par IPC : `restart` (arrêt propre, nouveau serveur sur le même
 * port : salles froides, rechargées de leur point de sauvegarde + journal),
 * `metrics`, `stop`.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.COLLAB_JOIN_ROOT ?? process.cwd();
const endpoint = process.env.COLLAB_JOIN_APPWRITE!;
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { createMultiplayerServer } = await load('server/multiplayer/server.ts') as typeof import('../../server/multiplayer/server.ts');
const { createAppwriteStorage } = await load('server/multiplayer/appwriteStorage.ts') as typeof import('../../server/multiplayer/appwriteStorage.ts');

// node-appwrite signale à chaque réponse un écart de version de serveur : bruit.
const consoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Warning:')) return;
  consoleWarn(...args);
};

const appwrite = { endpoint, projectId: 'banc', apiKey: 'cle-banc' };
const errors: string[] = [];
type Server = ReturnType<typeof createMultiplayerServer>;

function createServer(): Server {
  return createMultiplayerServer({
    storage: createAppwriteStorage({ ...appwrite, databaseId: 'redview-db' }),
    appwrite,
    devAuth: false,
    // Toutes les connexions du banc viennent de 127.0.0.1 : plafonds par IP levés.
    limits: { perIp: 1_000_000, upgradesPerIpPerMinute: 1_000_000, perUser: 1_000_000 },
    host: {
      shadowValidationIntervalMs: 0,
      log: (level, message, data) => {
        if (level === 'error') errors.push(`${message} ${JSON.stringify(data ?? {})}`.slice(0, 300));
      },
    },
  });
}

let server = createServer();
const port = await server.listen(0, '127.0.0.1');

process.on('message', (message: { type: string }) => {
  void (async () => {
    if (message.type === 'metrics') {
      process.send!({ type: 'metrics', metrics: server.host.snapshotMetrics(), errors: errors.splice(0) });
    } else if (message.type === 'restart') {
      await server.shutdown();
      server = createServer();
      await server.listen(port, '127.0.0.1');
      process.send!({ type: 'restarted' });
    } else if (message.type === 'stop') {
      await server.shutdown();
      process.exit(0);
    }
  })();
});
process.on('disconnect', () => process.exit(0));
process.send!({ type: 'ready', port });
