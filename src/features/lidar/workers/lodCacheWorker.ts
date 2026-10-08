/// <reference lib="webworker" />

// Construit l'octree LOD d'une tuile + les blocs de nœuds empaquetés hors du
// thread principal et le stocke dans le cache LOD OPFS. Quand l'OPFS ne peut pas
// le contenir, les données empaquetées sont renvoyées pour que le viewer lise
// les nœuds en flux depuis la mémoire à la place. Met aussi à niveau un cache
// écrit par une version plus ancienne (voir lodCache.ts).

import { saveLodTile, upgradeLegacyLodTile } from '../lib/lodCache';
import { buildLodTile, type LodNode, type LodTileHeader, type LodTileInput } from '../viewer/lod/lodTile';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type LodCacheRequest =
  | {
    type: 'build';
    lazFileName: string;
    input: LodTileInput;
    /** False garde la tuile en mémoire seulement (par ex. échec de la colorisation : nouvel essai à la prochaine visite). */
    persist: boolean;
  }
  | { type: 'upgrade'; lazFileName: string };

export type LodCacheResponse =
  | { type: 'done'; header: LodTileHeader; nodes: LodNode[]; stored: boolean; packed?: Uint8Array }
  | { type: 'upgraded'; upgraded: boolean }
  | { type: 'error'; message: string };

workerScope.onmessage = async (e: MessageEvent<LodCacheRequest>) => {
  if (e.data.type === 'upgrade') {
    try {
      const upgraded = await upgradeLegacyLodTile(e.data.lazFileName);
      workerScope.postMessage({ type: 'upgraded', upgraded } satisfies LodCacheResponse);
    } catch (err: unknown) {
      workerScope.postMessage({ type: 'error', message: (err as Error)?.message || String(err) } satisfies LodCacheResponse);
    }
    return;
  }
  if (e.data.type !== 'build') return;
  try {
    const tile = buildLodTile(e.data.input);
    const stored = e.data.persist ? await saveLodTile(e.data.lazFileName, tile) : false;
    if (stored) {
      workerScope.postMessage({ type: 'done', header: tile.header, nodes: tile.nodes, stored } satisfies LodCacheResponse);
    } else {
      workerScope.postMessage(
        { type: 'done', header: tile.header, nodes: tile.nodes, stored, packed: tile.packed } satisfies LodCacheResponse,
        [tile.packed.buffer],
      );
    }
  } catch (err: unknown) {
    workerScope.postMessage({ type: 'error', message: (err as Error)?.message || String(err) } satisfies LodCacheResponse);
  }
};
