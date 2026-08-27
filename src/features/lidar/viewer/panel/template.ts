const PANEL_TEMPLATE = `
  <div id="viewer-panel" class="viewer-panel">
    <div id="viewer-panel-resize-handle" class="viewer-panel__resize-handle" role="separator" aria-orientation="vertical" aria-label="Redimensionner le panneau"></div>
    <div class="viewer-panel__header">
      <span class="viewer-panel__header-icon" aria-hidden="true">
        <svg class="viewer-panel__icon viewer-panel__icon--header" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.67" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.66667 2.5H6.5C5.09987 2.5 4.3998 2.5 3.86502 2.77248C3.39462 3.01217 3.01217 3.39462 2.77248 3.86502C2.5 4.3998 2.5 5.09987 2.5 6.5V6.66667M6.66667 17.5H6.5C5.09987 17.5 4.3998 17.5 3.86502 17.2275C3.39462 16.9878 3.01217 16.6054 2.77248 16.135C2.5 15.6002 2.5 14.9001 2.5 13.5V13.3333M17.5 6.66667V6.5C17.5 5.09987 17.5 4.3998 17.2275 3.86502C16.9878 3.39462 16.6054 3.01217 16.135 2.77248C15.6002 2.5 14.9001 2.5 13.5 2.5H13.3333M17.5 13.3333V13.5C17.5 14.9001 17.5 15.6002 17.2275 16.135C16.9878 16.6054 16.6054 16.9878 16.135 17.2275C15.6002 17.5 14.9001 17.5 13.5 17.5H13.3333"></path>
        </svg>
      </span>
      <div class="viewer-panel__title-block">
        <p class="viewer-panel__title">Viewer Lidar</p>
      </div>
    </div>
    <div class="viewer-panel__tile-row">
      <span class="viewer-panel__tile-icon" aria-hidden="true">
        <svg class="viewer-panel__icon viewer-panel__icon--tile" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 1.35 10.2 3.65v4.7L6 10.65 1.8 8.35v-4.7L6 1.35Z"></path>
          <path d="M1.8 3.65 6 5.95l4.2-2.3"></path>
          <path d="M6 5.95v4.7"></path>
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
        <span class="viewer-panel__maps-icon-wrap" aria-hidden="true">
          <svg class="viewer-panel__icon viewer-panel__icon--maps" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="5.5"></circle>
            <path d="M2.5 8h11"></path>
            <path d="M8 2.5c1.7 1.8 2.6 3.6 2.6 5.5S9.7 11.7 8 13.5C6.3 11.7 5.4 9.9 5.4 8S6.3 4.3 8 2.5Z"></path>
          </svg>
        </span>
      </a>
    </div>
    <div class="viewer-panel__divider"></div>
    <div class="viewer-panel__select-row viewer-panel__select-row--engine">
      <p class="viewer-panel__label">Moteur</p>
      <div class="viewer-panel__select-wrap viewer-panel__select-wrap--engine">
        <button id="panel-engine-mode-button" class="viewer-panel__select-trigger viewer-panel__select-trigger--soft" type="button" aria-haspopup="listbox" aria-expanded="false">
          <span id="panel-engine-mode-value">WebGpu (+ precis)</span>
          <svg class="viewer-panel__select-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m5 7.5 5 5 5-5"></path>
          </svg>
        </button>
        <div id="panel-engine-mode-menu" class="viewer-panel__select-menu viewer-panel__select-menu--engine" role="listbox" hidden>
          <button class="viewer-panel__select-option is-selected" type="button" role="option" data-engine-mode-option="webgpu" aria-selected="true">
            <span class="viewer-panel__select-option-label">WebGpu (+ precis)</span>
            <svg class="viewer-panel__select-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m3.5 8.2 2.7 2.7 6-6"></path>
            </svg>
          </button>
          <button class="viewer-panel__select-option" type="button" role="option" data-engine-mode-option="webgl" aria-selected="false">
            <span class="viewer-panel__select-option-label">WebGl HD</span>
            <svg class="viewer-panel__select-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m3.5 8.2 2.7 2.7 6-6"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div id="panel-point-controls" class="viewer-panel__point-controls">
      <div class="viewer-panel__range-row">
        <p class="viewer-panel__label">Taille des points</p>
        <span class="viewer-panel__range-bound">1</span>
        <input id="panel-point-size" class="viewer-panel__range" type="range" min="1" max="100" value="50" />
        <span class="viewer-panel__range-bound">100</span>
      </div>
      <div class="viewer-panel__range-row">
        <p class="viewer-panel__label">Densité des points</p>
        <span class="viewer-panel__range-bound">1</span>
        <input id="panel-point-density" class="viewer-panel__range" type="range" min="1" max="100" value="100" />
        <span class="viewer-panel__range-bound">100</span>
      </div>
    </div>
    <div id="panel-elevation-controls" class="viewer-panel__elevation-controls" hidden>
      <div class="viewer-panel__range-row">
        <p class="viewer-panel__label">Exagération d'élévation</p>
        <span class="viewer-panel__range-bound">0.5×</span>
        <input id="panel-elevation-exaggeration" class="viewer-panel__range" type="range" min="1" max="100" value="25" />
        <span class="viewer-panel__range-bound">3.0×</span>
      </div>
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
        <button id="panel-snow-mode-button" class="viewer-panel__select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
          <span id="panel-snow-mode-value">Couverture neigeuse</span>
          <svg class="viewer-panel__select-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m4 6 4 4 4-4"></path>
          </svg>
        </button>
        <div id="panel-snow-mode-menu" class="viewer-panel__select-menu" role="listbox" hidden>
          <button class="viewer-panel__select-option is-selected" type="button" role="option" data-snow-mode-option="cover" aria-selected="true">
            <span class="viewer-panel__select-option-label">Couverture neigeuse</span>
            <svg class="viewer-panel__select-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m3.5 8.2 2.7 2.7 6-6"></path>
            </svg>
          </button>
          <button class="viewer-panel__select-option" type="button" role="option" data-snow-mode-option="thickness" aria-selected="false">
            <span class="viewer-panel__select-option-label">Epaisseur (cm)</span>
            <svg class="viewer-panel__select-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m3.5 8.2 2.7 2.7 6-6"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="viewer-panel__divider"></div>
    <section class="viewer-panel__tile-nav" aria-label="Navigation des tuiles LiDAR">
      <p id="viewer-tile-nav-status" class="viewer-panel__sr-only" aria-live="polite">
        Chargement des tuiles voisines.
      </p>
      <div id="viewer-tile-nav-grid" class="viewer-panel__tile-nav-grid" role="grid"></div>
    </section>
    <button id="panel-engine-btn" class="viewer-panel__cta" type="button">
      <span class="viewer-panel__cta-icon" aria-hidden="true">
        <svg class="viewer-panel__cta-icon-svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7.5 3.75H5.25A2.25 2.25 0 0 0 3 6v6A2.25 2.25 0 0 0 5.25 14.25H7.5"></path>
          <path d="M10.5 12.75 14.25 9 10.5 5.25"></path>
          <path d="M14.25 9H7.5"></path>
        </svg>
      </span>
      <span id="panel-engine-btn-label">Quitter le mode LIDAR</span>
    </button>
  </div>

  <div id="viewer-left-collapsed-rail" class="viewer-left-collapsed-rail">
    <button id="viewer-left-restore-btn" class="viewer-collapsed-rail-btn" type="button" aria-label="Rouvrir le panneau LiDAR">
      <svg class="viewer-collapsed-rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
      </svg>
    </button>
  </div>
`;

export function ensureViewerPanel(): HTMLDivElement {
  const existing = document.getElementById('viewer-panel');
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const fragment = document.createRange().createContextualFragment(PANEL_TEMPLATE.trim());
  const root = fragment.querySelector('#viewer-panel');
  if (!(root instanceof HTMLDivElement)) {
    throw new Error('Viewer panel template did not produce a root div.');
  }

  document.body.append(fragment);
  return root;
}