/**
 * Serveur temps réel du test de charge (processus enfant de run.ts) : le vrai
 * serveur (server/multiplayer) sur un stockage de fichiers temporaire, avec
 * une latence d'écriture façon Appwrite (`LOAD_STORAGE_LATENCY_MS` ± 50 %)
 * pour que le journal et les points de sauvegarde se mesurent comme en
 * production. Piloté par IPC : `measure` (mesures après un ramasse-miettes
 * complet), `stop`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileStorage } from '../../server/multiplayer/fileStorage.ts';
import { createMultiplayerServer } from '../../server/multiplayer/server.ts';
import type { RoomStorage } from '../../server/multiplayer/storage.ts';

const latencyMs = Number(process.env.LOAD_STORAGE_LATENCY_MS ?? 60);
const shadowValidationIntervalMs = Number(process.env.LOAD_SHADOW_INTERVAL_MS ?? 20_000);
const checkpointIntervalMs = Number(process.env.LOAD_CHECKPOINT_INTERVAL_MS ?? 15_000);

const pause = () => new Promise((resolve) => setTimeout(resolve, latencyMs * (0.5 + Math.random())));

function withLatency(storage: RoomStorage): RoomStorage {
  return {
    kind: storage.kind,
    access: (projectId) => storage.access(projectId),
    loadRoom: async (projectId, seed) => (await pause(), storage.loadRoom(projectId, seed)),
    appendJournal: async (projectId, batches) => (await pause(), storage.appendJournal(projectId, batches)),
    // Un point de sauvegarde, c'est un fichier + une ligne : deux allers-retours.
    saveCheckpoint: async (projectId, write) => (await pause(), await pause(), storage.saveCheckpoint(projectId, write)),
    pruneJournal: async (projectId, uptoSeq) => (await pause(), storage.pruneJournal(projectId, uptoSeq)),
    readDurable: async (projectId) => (await pause(), storage.readDurable(projectId)),
    purgeRoom: (projectId) => storage.purgeRoom(projectId),
  };
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'redview-load-'));
const errors: string[] = [];
const server = createMultiplayerServer({
  storage: withLatency(createFileStorage(dir)),
  appwrite: null,
  devAuth: true,
  // Toutes les connexions du banc viennent de 127.0.0.1 : plafonds par IP levés.
  limits: { perIp: 1_000_000, upgradesPerIpPerMinute: 1_000_000, perUser: 1_000_000 },
  host: {
    checkpointIntervalMs,
    shadowValidationIntervalMs,
    log: (level, message, data) => {
      if (level === 'error') errors.push(`${message} ${JSON.stringify(data ?? {})}`.slice(0, 300));
    },
  },
});
const port = await server.listen(0);

const gc = (globalThis as { gc?: () => void }).gc;

process.on('message', (message: { type: string }) => {
  void (async () => {
    if (message.type === 'measure') {
      for (let round = 0; round < 3; round += 1) {
        gc?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      process.send!({ type: 'metrics', metrics: server.host.snapshotMetrics(), errors: errors.slice(0, 10), gc: !!gc });
    } else if (message.type === 'stop') {
      await server.shutdown();
      await rm(dir, { recursive: true, force: true });
      process.exit(0);
    }
  })();
});

// Banc interrompu : le serveur ne lui survit pas.
process.on('disconnect', () => {
  void rm(dir, { recursive: true, force: true }).finally(() => process.exit(0));
});

process.send!({ type: 'ready', port });
