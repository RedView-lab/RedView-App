const PANEL_TEMPLATE = `
  <div id="viewer-panel" class="viewer-panel">
    <div class="viewer-panel__header">
      <div class="viewer-panel__title-block">
        <p class="viewer-panel__title">Viewer Lidar</p>
      </div>
      <div class="viewer-panel__header-actions">
        <button id="panel-settings-btn" class="viewer-panel__icon-button" type="button" aria-label="Ouvrir les reglages complementaires" aria-expanded="false">
          <svg class="viewer-panel__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4h10"></path>
            <path d="M3 12h10"></path>
            <path d="M5 8h6"></path>
            <circle cx="6" cy="4" r="1.5" fill="currentColor" stroke="none"></circle>
            <circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none"></circle>
            <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
          </svg>
        </button>
        <div id="panel-settings-menu" class="viewer-panel__settings-menu" hidden>
          <div id="export-wrap">
            <button id="export-btn" type="button">⤓ Exporter</button>
            <div id="export-menu" class="viewer-panel__export-menu" hidden>
              <button class="export-format-btn" data-format="gltf" type="button">GLTF</button>
              <button class="export-format-btn" data-format="fbx" type="button">FBX</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="viewer-panel__tile-row">
      <span class="viewer-panel__tile-icon" aria-hidden="true">
        <svg class="viewer-panel__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 1.8 13 4.6v6.8L8 14.2 3 11.4V4.6L8 1.8Z"></path>
          <path d="M3 4.6 8 7.4l5-2.8"></path>
          <path d="M8 7.4v6.8"></path>
        </svg>
      </span>
      <p id="panel-tile-label" class="viewer-panel__tile-label">Tuile LiDAR</p>
    </div>
    <div class="viewer-panel__divider"></div>
    <p class="viewer-panel__section-title">Localisation</p>
    <div class="viewer-panel__location-row">
      <p id="panel-location-value" class="viewer-panel__location-value">0° 00′ 00″ N</p>
      <a id="panel-maps-link" class="viewer-panel__maps-link" href="https://www.google.com/maps" target="_blank" rel="noreferrer noopener">
        <span>GoogleMaps</span>
        <svg class="viewer-panel__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5"></circle>
          <path d="M2.5 8h11"></path>
          <path d="M8 2.5c1.7 1.8 2.6 3.6 2.6 5.5S9.7 11.7 8 13.5C6.3 11.7 5.4 9.9 5.4 8S6.3 4.3 8 2.5Z"></path>
        </svg>
      </a>
    </div>
    <div class="viewer-panel__divider"></div>
    <div class="viewer-panel__range-row">
      <p class="viewer-panel__label">Taille des points</p>
      <span class="viewer-panel__range-bound">1</span>
      <input id="panel-point-size" class="viewer-panel__range" type="range" min="1" max="100" value="50" />
      <span class="viewer-panel__range-bound">100</span>
    </div>
    <div class="viewer-panel__range-row">
      <p class="viewer-panel__label">Densite des points</p>
      <span class="viewer-panel__range-bound">1</span>
      <input id="panel-point-density" class="viewer-panel__range" type="range" min="1" max="100" value="100" />
      <span class="viewer-panel__range-bound">100</span>
    </div>
    <div class="viewer-panel__divider"></div>
    <div class="viewer-panel__toggle-row">
      <p class="viewer-panel__label">Neige</p>
      <label class="viewer-panel__switch" aria-label="Activer ou desactiver la neige">
        <input id="panel-snow-toggle" type="checkbox" />
        <span class="viewer-panel__switch-track"></span>
        <span class="viewer-panel__switch-thumb"></span>
      </label>
    </div>
    <div class="viewer-panel__select-row">
      <p class="viewer-panel__label">Affichage</p>
      <div class="viewer-panel__select-wrap">
        <select id="panel-snow-mode" class="viewer-panel__select">
          <option value="cover">Couverture neigeuse</option>
          <option value="thickness">Epaisseur (cm)</option>
        </select>
        <svg class="viewer-panel__select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4"></path>
        </svg>
      </div>
    </div>
    <div class="viewer-panel__divider"></div>
    <button id="panel-engine-btn" class="viewer-panel__cta" type="button">
      <span class="viewer-panel__cta-icon" aria-hidden="true">
        <svg class="viewer-panel__cta-icon-svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.5 2.25H6.75a2.25 2.25 0 0 0-2.25 2.25V13.5a2.25 2.25 0 0 0 2.25 2.25h4.5A2.25 2.25 0 0 0 13.5 13.5v-1.875"></path>
          <path d="M8.25 9 15.75 1.5"></path>
          <path d="M12 1.5h3.75v3.75"></path>
        </svg>
      </span>
      <span id="panel-engine-btn-label">Passer en mode LowQuality</span>
    </button>
  </div>
`;

export function ensureViewerPanel(): HTMLDivElement {
  const existing = document.getElementById('viewer-panel');
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const fragment = document.createRange().createContextualFragment(PANEL_TEMPLATE.trim());
  const root = fragment.firstElementChild;
  if (!(root instanceof HTMLDivElement)) {
    throw new Error('Viewer panel template did not produce a root div.');
  }

  document.body.append(root);
  return root;
}