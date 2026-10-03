/// <reference lib="webworker" />

// Builds a tile's LOD octree + packed node blocks off the main thread and
// stores it in the OPFS LOD cache. When OPFS cannot hold it, the packed
// data is sent back so the viewer can stream nodes from memory instead.
// Also upgrades a cache written by an older version (see lodCache.ts).

import { saveLodTile, upgradeLegacyLodTile } from '../lib/lodCache';
import { buildLodTile, type LodNode, type LodTileHeader, type LodTileInput } from '../viewer/lod/lodTile';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

export type LodCacheRequest =
  | {
    type: 'build';
    lazFileName: string;
    input: LodTileInput;
    /** False keeps the tile in memory only (e.g. colourisation failed: retry next visit). */
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
