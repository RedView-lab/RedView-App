import type { TileCoord } from '../../types';
import { LidarManager } from '../../lib/lidarManager';
import { MAX_VIEWER_SCENE_TILES } from '../../lib/viewerUrl';
import { ensureViewerPanel } from '../panel/template';
import { buildTileNavigatorCells, buildTileNavigatorLabel, tileCoordKey } from './model';

interface ViewerTileNavigatorOptions {
  currentTile: TileCoord;
  activeTiles: TileCoord[];
  manager: LidarManager;
  onPreviewTile?: (coord: TileCoord | null) => void;
  onSelectTiles: (coords: TileCoord[]) => void;
}

function sameTile(a: TileCoord | undefined, b: TileCoord): boolean {
  return Boolean(a)
    && a!.xKm === b.xKm
    && a!.yKm === b.yKm
    && a!.projection === b.projection
    && a!.altRef === b.altRef;
}

const DOWNLOAD_ICON = `
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 3.75v7.5"></path>
    <path d="m5.75 8.5 3.25 3.25 3.25-3.25"></path>
    <path d="M4 14.25h10"></path>
  </svg>
`;

const EYE_ICON = `
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1.75 9s2.7-4.25 7.25-4.25S16.25 9 16.25 9s-2.7 4.25-7.25 4.25S1.75 9 1.75 9Z"></path>
    <circle cx="9" cy="9" r="2.15"></circle>
  </svg>
`;

const EYE_OFF_ICON = `
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2.25 2.25 15.75 15.75"></path>
    <path d="M7.4 4.95A8.17 8.17 0 0 1 9 4.75c4.55 0 7.25 4.25 7.25 4.25a13.3 13.3 0 0 1-2.15 2.6"></path>
    <path d="M10.6 10.6A2.3 2.3 0 0 1 7.4 7.4"></path>
    <path d="M5.12 5.12C3.11 6.2 1.75 9 1.75 9S4.45 13.25 9 13.25c1.25 0 2.37-.32 3.36-.8"></path>
  </svg>
`;

const LOADING_ICON = `
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
    <path d="M9 2.5v2.2"></path>
    <path d="M9 13.3v2.2"></path>
    <path d="m4.4 4.4 1.55 1.55"></path>
    <path d="m12.05 12.05 1.55 1.55"></path>
    <path d="M2.5 9h2.2"></path>
    <path d="M13.3 9h2.2"></path>
    <path d="m4.4 13.6 1.55-1.55"></path>
    <path d="m12.05 5.95 1.55-1.55"></path>
  </svg>
`;

function buildCellIconMarkup(icon: string): string {
  return `<span class="viewer-panel__tile-nav-cell-icon" aria-hidden="true">${icon}</span>`;
}

export function createViewerTileNavigator(options: ViewerTileNavigatorOptions) {
  const root = ensureViewerPanel();
  const gridEl = root.querySelector('#viewer-tile-nav-grid');
  const statusEl = root.querySelector('#viewer-tile-nav-status');

  if (!(gridEl instanceof HTMLDivElement) || !(statusEl instanceof HTMLParagraphElement)) {
    throw new Error('Tile navigator DOM is incomplete.');
  }

  let currentTile = options.currentTile;
  const activeTiles = options.activeTiles.slice(0, MAX_VIEWER_SCENE_TILES);
  const activeTileKeys = new Set(activeTiles.map((tile) => tileCoordKey(tile)));
  let destroyed = false;
  let loadingTileKey: string | null = null;
  let cachedTileKeys = new Set<string>();
  let pendingTile: TileCoord | null = null;

  const defaultStatus =
    `${activeTiles.length}/${MAX_VIEWER_SCENE_TILES} tuiles actives | ` +
    'rouge = principale | ambre = actives | orange = cache';

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
      const isActiveSecondary = !isCurrent && activeTileKeys.has(cellKey);
      const isPending = pendingTile ? sameTile(pendingTile, cell.coord) : false;
      const isCached = cachedTileKeys.has(cellKey);
      const button = document.createElement('button');
      let iconMarkup = buildCellIconMarkup(DOWNLOAD_ICON);

      button.type = 'button';
      button.className = 'viewer-panel__tile-nav-cell';
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', buildTileNavigatorLabel(cell));
      button.title = buildTileNavigatorLabel(cell);

      if (isCurrent) {
        button.classList.add('is-current');
        iconMarkup = buildCellIconMarkup(EYE_ICON);
      } else if (isLoading) {
        button.classList.add('is-loading');
        iconMarkup = buildCellIconMarkup(LOADING_ICON);
      } else if (isPending) {
        button.classList.add('is-pending');
      } else if (isActiveSecondary) {
        button.classList.add('is-paired');
        iconMarkup = buildCellIconMarkup(EYE_OFF_ICON);
      } else if (isCached) {
        button.classList.add('is-cached');
      } else {
        button.classList.add('is-idle');
      }

      button.innerHTML = iconMarkup;

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

    if (!pendingTile || !sameTile(pendingTile, coord)) {
      const isActiveSecondary = activeTileKeys.has(targetKey) && !sameTile(currentTile, coord);
      pendingTile = coord;
      options.onPreviewTile?.(coord);
      if (isActiveSecondary) {
        setStatus(`Preview ${coord.xKm}/${coord.yKm} · reclique pour retirer`);
      } else if (cachedTileKeys.has(targetKey)) {
        if (activeTiles.length >= MAX_VIEWER_SCENE_TILES) {
          setStatus(`Preview ${coord.xKm}/${coord.yKm} · limite ${MAX_VIEWER_SCENE_TILES} tuiles atteinte`);
        } else {
          setStatus(`Preview ${coord.xKm}/${coord.yKm} · reclique pour ajouter`);
        }
      } else {
        setStatus(`Preview ${coord.xKm}/${coord.yKm} · reclique pour telecharger`);
      }
      render();
      return;
    }

    if (activeTileKeys.has(targetKey) && !sameTile(currentTile, coord)) {
      pendingTile = null;
      options.onPreviewTile?.(null);
      setStatus(`Retrait ${coord.xKm}/${coord.yKm} du lot...`);
      options.onSelectTiles(activeTiles.filter((tile) => !sameTile(tile, coord)));
      return;
    }

    if (cachedTileKeys.has(targetKey)) {
      if (activeTiles.length >= MAX_VIEWER_SCENE_TILES) {
        setStatus(`Limite atteinte: ${MAX_VIEWER_SCENE_TILES} tuiles maximum.`);
        pendingTile = null;
        options.onPreviewTile?.(null);
        render();
        return;
      }

      pendingTile = null;
      options.onPreviewTile?.(null);
      setStatus(`Assemblage ${activeTiles.length + 1}/${MAX_VIEWER_SCENE_TILES} tuiles...`);
      options.onSelectTiles([...activeTiles, coord]);
      return;
    }

    loadingTileKey = targetKey;
    pendingTile = null;
    options.onPreviewTile?.(null);
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

    if (activeTiles.length >= MAX_VIEWER_SCENE_TILES) {
      setStatus(`Tuile telechargee, mais limite ${MAX_VIEWER_SCENE_TILES} deja atteinte.`);
      return;
    }

    setStatus(`Assemblage ${activeTiles.length + 1}/${MAX_VIEWER_SCENE_TILES} tuiles...`);
    options.onSelectTiles([...activeTiles, coord]);
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
      options.onPreviewTile?.(null);
      unsubscribe();
      gridEl.replaceChildren();
      setStatus('');
    },
  };
}