import redviewLogoIconUrl from './redview-logo-icon.svg';

export interface ViewerLoadingOverlayElements {
  statusEl: HTMLElement;
  detailEl: HTMLElement;
  barFill: HTMLElement;
  percentEl: HTMLElement;
}

function requireElement<T extends HTMLElement>(root: HTMLElement, selector: string, name: string): T {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${name} in viewer loading overlay`);
  }
  return element as T;
}

export function createViewerLoadingOverlay(overlay: HTMLElement): ViewerLoadingOverlayElements {
  overlay.innerHTML = `
    <div class="rv-lidar-loader" role="progressbar" aria-label="Chargement du Viewer LIDAR" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="rv-lidar-loader__brand" aria-hidden="true">
        <div class="rv-lidar-loader__wordmark">
          <span class="rv-lidar-loader__wordmark-red">RED</span>
          <span class="rv-lidar-loader__wordmark-view">view</span>
          <span class="rv-lidar-loader__brand-icon">
            <img class="rv-lidar-loader__brand-icon-svg" src="${redviewLogoIconUrl}" alt="" />
          </span>
        </div>
      </div>
      <div class="rv-lidar-loader__progress-shell">
        <div class="rv-lidar-loader__track">
          <div id="bar-fill" class="rv-lidar-loader__fill"></div>
        </div>
        <div id="progress-percent" class="rv-lidar-loader__percent">0%</div>
      </div>
      <p id="status" class="rv-lidar-loader__status">Chargement du Viewer LIDAR</p>
      <p id="status-detail" class="rv-lidar-loader__detail" aria-live="polite">Initialisation...</p>
    </div>
  `;

  return {
    statusEl: requireElement(overlay, '#status', 'status text'),
    detailEl: requireElement(overlay, '#status-detail', 'status detail'),
    barFill: requireElement(overlay, '#bar-fill', 'progress fill'),
    percentEl: requireElement(overlay, '#progress-percent', 'progress percent'),
  };
}