import type { TileCoord } from '../../types';
import { LidarManager } from '../../lib/lidarManager';
import { buildTileNavigatorCells, buildTileNavigatorLabel, tileCoordKey } from './model';
import { ensureViewerTileNavigator } from './template';

interface ViewerTileNavigatorOptions {
  currentTile: TileCoord;
  pairedTile?: TileCoord | null;
  manager: LidarManager;
  onSelectTile: (coord: TileCoord) => void;
}

function sameTile(a: TileCoord | undefined, b: TileCoord): boolean {
  return Boolean(a)
    && a!.xKm === b.xKm
    && a!.yKm === b.yKm
    && a!.projection === b.projection
    && a!.altRef === b.altRef;
}

export function createViewerTileNavigator(options: ViewerTileNavigatorOptions) {
  const root = ensureViewerTileNavigator();
  const gridEl = document.getElementById('viewer-tile-nav-grid');
  const statusEl = document.getElementById('viewer-tile-nav-status');

  if (!(gridEl instanceof HTMLDivElement) || !(statusEl instanceof HTMLParagraphElement)) {
    throw new Error('Tile navigator DOM is incomplete.');
  }

  let currentTile = options.currentTile;
  const pairedTile = options.pairedTile ?? null;
  let destroyed = false;
  let loadingTileKey: string | null = null;
  let cachedTileKeys = new Set<string>();

  const defaultStatus = pairedTile
    ? '2 tuiles actives | rouge = principale | ambre = secondaire'
    : 'Rouge = ouverte | orange = cache | gris = a telecharger';

  const setStatus = (message: string) => {
    statusEl.textContent = message;
  };

  const render = () => {
    const cells = buildTileNavigatorCells(currentTile);
    gridEl.replaceChildren();

    for (const cell of cells) {
      const cellKey = tileCoordKey(cell.coord);
      const isCurrent = sameTile(currentTile, cell.coord);
      const isLoading = loadingTileKey === cellKey;
      const isPaired = pairedTile ? sameTile(pairedTile, cell.coord) : false;
      const isCached = cachedTileKeys.has(cellKey);
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'viewer-tile-nav__cell';
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', buildTileNavigatorLabel(cell));
      button.title = buildTileNavigatorLabel(cell);

      if (isCurrent) button.classList.add('is-current');
      else if (isLoading) button.classList.add('is-loading');
      else if (isPaired) button.classList.add('is-paired');
      else if (isCached) button.classList.add('is-cached');
      else button.classList.add('is-idle');

      if (loadingTileKey && !isLoading) button.disabled = true;
      if (isCurrent) button.disabled = true;

      button.addEventListener('click', () => {
        void handleTileClick(cell.coord);
      });

      gridEl.append(button);
    }
  };

  const refreshCachedTiles = async () => {
    const tiles = await options.manager.getCachedTiles();
    if (destroyed) return;
    cachedTileKeys = new Set(tiles.map((tile) => tileCoordKey(tile.coord)));
    render();
  };

  const waitForDownload = (coord: TileCoord): Promise<boolean> => {
    return new Promise((resolve) => {
      let settled = false;
      const stop = options.manager.on((event) => {
        if (!sameTile(event.tileCoord, coord)) return;
        if (event.type === 'tileLoaded') {
          settled = true;
          stop();
          resolve(true);
        }
        if (event.type === 'error') {
          settled = true;
          stop();
          resolve(false);
        }
      });

      void options.manager.downloadTile(coord).finally(() => {
        if (!settled && cachedTileKeys.has(tileCoordKey(coord))) {
          stop();
          resolve(true);
        }
      });
    });
  };

  const handleTileClick = async (coord: TileCoord) => {
    const targetKey = tileCoordKey(coord);
    if (loadingTileKey || sameTile(currentTile, coord)) return;

    if (cachedTileKeys.has(targetKey)) {
      setStatus(`Assemblage ${currentTile.xKm}/${currentTile.yKm} + ${coord.xKm}/${coord.yKm}...`);
      options.onSelectTile(coord);
      return;
    }

    loadingTileKey = targetKey;
    setStatus(`Telechargement ${coord.xKm}/${coord.yKm}...`);
    render();

    const ok = await waitForDownload(coord);
    if (destroyed) return;

    loadingTileKey = null;
    await refreshCachedTiles();

    if (!ok) {
      setStatus(`Echec du telechargement ${coord.xKm}/${coord.yKm}`);
      return;
    }

    setStatus(`Assemblage ${currentTile.xKm}/${currentTile.yKm} + ${coord.xKm}/${coord.yKm}...`);
    options.onSelectTile(coord);
  };

  const unsubscribe = options.manager.on((event) => {
    if (!event.tileCoord) return;
    const eventKey = tileCoordKey(event.tileCoord);
    if (event.type === 'progress' && eventKey === loadingTileKey) {
      setStatus(event.progress?.message ?? `Telechargement ${event.tileCoord.xKm}/${event.tileCoord.yKm}...`);
    }
    if (event.type === 'tileLoaded' || event.type === 'tileRemoved') {
      void refreshCachedTiles();
    }
    if (event.type === 'error' && eventKey === loadingTileKey) {
      setStatus(event.error ?? 'Erreur de telechargement');
    }
  });

  setStatus(defaultStatus);
  void refreshCachedTiles();

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      root.remove();
    },
  };
}