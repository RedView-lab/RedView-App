import type { Map as MapboxMap } from 'mapbox-gl';
import { unifiedDEMSource } from '../../../lib/sources';

/**
 * Indique au service worker DEM les tuiles de terrain que la carte attend encore.
 *
 * Chromium ne propage jamais au service worker l'abandon d'un fetch côté page
 * (FetchEvent.request.signal reste muet) : quand Mapbox abandonne une tuile
 * DEM sortie de la vue, le SW ne peut pas savoir que son travail LiDAR est
 * devenu inutile. Il devinait — chaque geste de caméra annulait tout le travail
 * IGN — et tuait le travail des tuiles encore à l'écran : tourner ou incliner la
 * caméra les transformait en relief à 30 m, mis en cache ainsi. La page envoie à
 * la place les tuiles que sa source de terrain a en cours, avec une limitation
 * de fréquence pendant que la caméra bouge ; le SW n'abandonne que le travail des
 * autres (DEM_WANTED_TILES dans public/sw-dem/runtime/lifecycle.js). Seules les
 * requêtes marquées `rv-src=map` (buildDemTilesTemplate) sont jugées par ces
 * instantanés.
 */

const SYNC_INTERVAL_MS = 250;
// Mapbox retire les tuiles de la couverture au rendu qui suit le changement de
// caméra, pas dans le handler `moveend` lui-même.
const MOVE_END_DELAY_MS = 120;
const PENDING_TILE_STATES: ReadonlySet<string> = new Set(['loading', 'reloading', 'expired']);

interface DemTileLike {
  state?: string;
  tileID?: { canonical?: { z: number; x: number; y: number } };
}

interface StyleWithSourceCaches {
  getOwnSourceCache?: (id: string) => { _tiles?: Record<string, DemTileLike | undefined> } | undefined;
}

function readPendingDemTileKeys(map: MapboxMap): string[] | null {
  const style = (map as unknown as { style?: StyleWithSourceCaches }).style;
  const tiles = style?.getOwnSourceCache?.(unifiedDEMSource.id)?._tiles;
  if (!tiles) return null;
  const keys = new Set<string>();
  for (const tile of Object.values(tiles)) {
    const canonical = tile?.tileID?.canonical;
    if (!canonical || !tile?.state || !PENDING_TILE_STATES.has(tile.state)) continue;
    keys.add(`${canonical.z}/${canonical.x}/${canonical.y}`);
  }
  return [...keys];
}

export function installDemWantedTilesSync(map: MapboxMap): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPostAt = 0;

  const post = (): void => {
    timer = null;
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    let keys: string[] | null = null;
    try { keys = readPendingDemTileKeys(map); } catch { keys = null; }
    // Pas de source de terrain (mode rapide 30 m, changement de style) : rien à juger.
    if (!keys) return;
    lastPostAt = Date.now();
    try {
      controller.postMessage({ type: 'DEM_WANTED_TILES', keys, sentAt: lastPostAt });
    } catch { /* SW disparu */ }
  };

  const schedule = (delayMs: number): void => {
    if (timer != null) return;
    timer = setTimeout(post, delayMs);
  };

  const onMove = (): void => {
    schedule(Math.max(0, SYNC_INTERVAL_MS - (Date.now() - lastPostAt)));
  };

  const onMoveEnd = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    schedule(MOVE_END_DELAY_MS);
  };

  map.on('move', onMove);
  map.on('moveend', onMoveEnd);

  return () => {
    map.off('move', onMove);
    map.off('moveend', onMoveEnd);
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
}
