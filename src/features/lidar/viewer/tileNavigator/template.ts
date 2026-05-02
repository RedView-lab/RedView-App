const TILE_NAVIGATOR_TEMPLATE = `
  <section id="viewer-tile-navigator" class="viewer-tile-nav" aria-label="Mini map LiDAR">
    <div class="viewer-tile-nav__header">
      <p class="viewer-tile-nav__title">Mini map LiDAR</p>
      <p id="viewer-tile-nav-status" class="viewer-tile-nav__status">Rouge = ouverte | orange = cache | gris = a telecharger</p>
    </div>
    <div id="viewer-tile-nav-grid" class="viewer-tile-nav__grid" role="grid"></div>
  </section>
`;

export function ensureViewerTileNavigator(): HTMLElement {
  const existing = document.getElementById('viewer-tile-navigator');
  if (existing instanceof HTMLElement) {
    return existing;
  }

  const fragment = document.createRange().createContextualFragment(TILE_NAVIGATOR_TEMPLATE.trim());
  const root = fragment.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error('Tile navigator template did not produce a root element.');
  }

  document.body.append(root);
  return root;
}