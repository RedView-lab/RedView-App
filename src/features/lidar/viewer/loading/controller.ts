export interface ViewerLoadingOverlayElements {
  statusEl: HTMLElement;
  detailEl: HTMLElement;
  barFill: HTMLElement;
  percentEl: HTMLElement;
}

function buildBrandIconMarkup(): string {
  return `
    <svg class="rv-lidar-loader__brand-icon-svg" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="20" cy="20" r="18" stroke="rgba(255,255,255,0.92)" stroke-width="4"/>
      <path d="M20 10.5C25.2467 10.5 29.5 14.7533 29.5 20C29.5 25.2467 25.2467 29.5 20 29.5C14.7533 29.5 10.5 25.2467 10.5 20" stroke="rgba(255,255,255,0.92)" stroke-width="4" stroke-linecap="round"/>
      <path d="M19.6 12.4L28.8 15.8L25.4 25" stroke="rgba(255,255,255,0.92)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="19.8" cy="20.1" r="3.1" fill="rgba(255,255,255,0.92)"/>
    </svg>
  `.trim();
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
        <div class="rv-lidar-loader__brand-dot"></div>
        <div class="rv-lidar-loader__wordmark">
          <span class="rv-lidar-loader__wordmark-red">RED</span>
          <span class="rv-lidar-loader__wordmark-view">view</span>
          <span class="rv-lidar-loader__brand-icon">${buildBrandIconMarkup()}</span>
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