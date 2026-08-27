import type { TileCoord } from '../../types';
import { LidarManager } from '../../lib/lidarManager';
import { MAX_VIEWER_SCENE_TILES } from '../../lib/viewerUrl';
import { ensureViewerPanel } from '../panel/template';
import { buildTileFileCandidates } from '../session/datasetPointCap';
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

function ensureViewerDock() {
  let dock = document.getElementById('viewer-dock') as HTMLDivElement | null;
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'viewer-dock';
    dock.className = 'viewer-dock';
    dock.setAttribute('hidden', '');
    dock.setAttribute('role', 'status');
    dock.setAttribute('aria-live', 'polite');
    dock.innerHTML = `
      <div class="viewer-dock__track-shell">
        <div class="viewer-dock__track-fill"></div>
      </div>
      <div class="viewer-dock__percent">0%</div>
      <div class="viewer-dock__icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.67" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.0433 10.7442C16.8118 12.9191 15.5795 14.9572 13.5404 16.1345C10.1524 18.0905 5.82035 16.9298 3.86434 13.5419L3.656 13.181M2.95429 9.25584C3.1858 7.08092 4.41812 5.04282 6.45728 3.86551C9.84518 1.90951 14.1773 3.07029 16.1333 6.45819L16.3416 6.81904M2.91016 15.055L3.5202 12.7783L5.79691 13.3884M14.2012 6.61167L16.4779 7.22172L17.0879 4.94501"></path>
        </svg>
      </div>
    `;
    document.body.append(dock);
  }
  const trackFill = dock.querySelector('.viewer-dock__track-fill') as HTMLDivElement;
  const percentEl = dock.querySelector('.viewer-dock__percent') as HTMLDivElement;

  return {
    root: dock,
    trackFill,
    percentEl,
    show: () => dock!.removeAttribute('hidden'),
    hide: () => dock!.setAttribute('hidden', ''),
    setProgress: (pct: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      if (trackFill) trackFill.style.width = `${clamped <= 0 ? 0 : Math.max(8, clamped)}%`;
      if (percentEl) percentEl.textContent = `${clamped}%`;
    },
  };
}

export function createViewerTileNavigator(options: ViewerTileNavigatorOptions) {
  const root = ensureViewerPanel();
  const gridEl = root.querySelector('#viewer-tile-nav-grid');
  const statusEl = root.querySelector('#viewer-tile-nav-status');
  const dock = ensureViewerDock();

  if (!(gridEl instanceof HTMLDivElement) || !(statusEl instanceof HTMLParagraphElement)) {
    throw new Error('Tile navigator DOM is incomplete.');
  }

  let currentTile = options.currentTile;
  const activeTiles = options.activeTiles.slice(0, MAX_VIEWER_SCENE_TILES);
  const activeTileKeys = new Set(activeTiles.map((tile) => tileCoordKey(tile)));
  let destroyed = false;
  let loadingTileKey: string | null = null;
  let cachedTileKeys = new Set<string>();
  let previewTileKey: string | null = null;

  const defaultStatus =
    `${activeTiles.length}/${MAX_VIEWER_SCENE_TILES} tuile(s) active(s) · ` +
    '1er clic = prévisualisation 3D | 2e clic = télécharger';

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
      const isCached = cachedTileKeys.has(cellKey);
      const isPreviewing = previewTileKey === cellKey;
      const button = document.createElement('button');
      let iconMarkup = buildCellIconMarkup(DOWNLOAD_ICON);

      const label = buildTileNavigatorLabel(cell, { isCurrent, isActiveSecondary, isCached, isPreviewing });
      button.type = 'button';
      button.className = 'viewer-panel__tile-nav-cell';
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', label);
      button.title = label;

      if (isCurrent) {
        button.classList.add('is-current');
        iconMarkup = buildCellIconMarkup(EYE_ICON);
      } else if (isLoading) {
        button.classList.add('is-loading');
        iconMarkup = buildCellIconMarkup(LOADING_ICON);
      } else if (isActiveSecondary) {
        button.classList.add('is-paired');
        iconMarkup = buildCellIconMarkup(EYE_ICON);
      } else if (isPreviewing) {
        button.classList.add('is-previewing');
        iconMarkup = buildCellIconMarkup(isCached ? EYE_ICON : DOWNLOAD_ICON);
      } else if (isCached) {
        button.classList.add('is-cached');
        iconMarkup = buildCellIconMarkup(EYE_OFF_ICON);
      } else {
        button.classList.add('is-idle');
        iconMarkup = buildCellIconMarkup(DOWNLOAD_ICON);
      }

      button.innerHTML = iconMarkup;

      if (loadingTileKey && !isLoading) button.disabled = true;
      if (isCurrent) button.disabled = true;

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        void handleTileClick(cell.coord);
      });

      gridEl.append(button);
    }
  };

  const refreshCachedTiles = async () => {
    const cachedKeys = new Set<string>();
    const cells = buildTileNavigatorCells(currentTile);

    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('lidar-hd', { create: false });
      for (const cell of cells) {
        const { fileName, legacyFileName } = buildTileFileCandidates(cell.coord);
        let found = false;
        try {
          await dir.getFileHandle(fileName);
          found = true;
        } catch {
          try {
            await dir.getFileHandle(legacyFileName);
            found = true;
          } catch {
            // file absent
          }
        }
        if (found) {
          cachedKeys.add(tileCoordKey(cell.coord));
        }
      }
    } catch {
      try {
        const tiles = await options.manager.getCachedTiles();
        for (const tile of tiles) {
          cachedKeys.add(tileCoordKey(tile.coord));
        }
      } catch {
        // ignore
      }
    }

    if (destroyed) return;
    cachedTileKeys = cachedKeys;
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

    // If tile is already active in scene, clicking removes it
    if (activeTileKeys.has(targetKey)) {
      if (previewTileKey) {
        previewTileKey = null;
        options.onPreviewTile?.(null);
      }
      setStatus(`Retrait ${coord.xKm}/${coord.yKm}...`);
      options.onSelectTiles(activeTiles.filter((tile) => !sameTile(tile, coord)));
      return;
    }

    // 1st click: activate 3D preview model
    if (previewTileKey !== targetKey) {
      previewTileKey = targetKey;
      options.onPreviewTile?.(coord);
      const isCached = cachedTileKeys.has(targetKey);
      setStatus(
        isCached
          ? `Tuile ${coord.xKm}/${coord.yKm} en prévisualisation 3D · Recliquez pour afficher`
          : `Tuile ${coord.xKm}/${coord.yKm} en prévisualisation 3D · Recliquez pour confirmer et télécharger`,
      );
      render();
      return;
    }

    // 2nd click on the same previewed tile: confirm and proceed!
    previewTileKey = null;
    options.onPreviewTile?.(null);

    if (activeTiles.length >= MAX_VIEWER_SCENE_TILES) {
      setStatus(`Limite atteinte: ${MAX_VIEWER_SCENE_TILES} tuiles maximum.`);
      render();
      return;
    }

    // If tile is already in cache (OPFS), assemble immediately
    if (cachedTileKeys.has(targetKey)) {
      setStatus(`Assemblage ${activeTiles.length + 1}/${MAX_VIEWER_SCENE_TILES} tuiles en cours...`);
      options.onSelectTiles([...activeTiles, coord]);
      return;
    }

    // If not in cache, start download and assemble once downloaded
    loadingTileKey = targetKey;
    dock.setProgress(0);
    dock.show();
    setStatus(`Téléchargement de la dalle ${coord.xKm}/${coord.yKm}...`);
    render();

    const ok = await waitForDownload(coord);
    if (destroyed) return;

    loadingTileKey = null;
    await refreshCachedTiles();

    if (!ok) {
      dock.hide();
      setStatus(`Échec du téléchargement ${coord.xKm}/${coord.yKm}`);
      render();
      return;
    }

    dock.setProgress(100);
    setTimeout(() => {
      if (!loadingTileKey) dock.hide();
    }, 400);

    setStatus(`Téléchargement terminé · Affichage simultané des ${activeTiles.length + 1} dalles...`);
    options.onSelectTiles([...activeTiles, coord]);
  };

  const handleDocumentClick = (e: MouseEvent) => {
    if (!previewTileKey) return;
    const target = e.target as HTMLElement | null;
    if (gridEl.contains(target)) return;
    previewTileKey = null;
    options.onPreviewTile?.(null);
    setStatus(defaultStatus);
    render();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && previewTileKey) {
      previewTileKey = null;
      options.onPreviewTile?.(null);
      setStatus(defaultStatus);
      render();
    }
  };

  document.addEventListener('click', handleDocumentClick);
  window.addEventListener('keydown', handleKeyDown);

  const unsubscribe = options.manager.on((event) => {
    if (!event.tileCoord) return;
    const eventKey = tileCoordKey(event.tileCoord);
    if (event.type === 'progress' && eventKey === loadingTileKey) {
      if (event.progress) {
        const pct = event.progress.percent
          ?? (event.progress.totalBytes > 0
            ? (event.progress.bytesDownloaded / event.progress.totalBytes) * 100
            : 0);
        dock.setProgress(pct);
      }
      setStatus(event.progress?.message ?? `Téléchargement ${event.tileCoord.xKm}/${event.tileCoord.yKm}...`);
    }
    if (event.type === 'tileLoaded' || event.type === 'tileRemoved') {
      void refreshCachedTiles();
    }
    if (event.type === 'error' && eventKey === loadingTileKey) {
      dock.hide();
      setStatus(event.error ?? 'Erreur de téléchargement');
    }
  });

  setStatus(defaultStatus);
  void refreshCachedTiles();

  return {
    destroy() {
      destroyed = true;
      options.onPreviewTile?.(null);
      document.removeEventListener('click', handleDocumentClick);
      window.removeEventListener('keydown', handleKeyDown);
      unsubscribe();
      dock.hide();
      dock.root.remove();
      gridEl.replaceChildren();
      setStatus('');
    },
  };
}