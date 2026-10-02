export interface PanelPlacement {
  horizontal: 'right' | 'left';
  vertical: 'down' | 'up';
}

/** Bords de la carte couverts par l'interface (panneaux latéraux, panneau du bas), en px. */
export interface MapOverlayInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PanelArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Zone où ancrer un panneau flottant : la carte visible entre les panneaux de
 * l'interface. Sur un axe où le panneau n'y tient pas, tout le conteneur.
 */
export function resolvePanelArea(
  containerWidth: number,
  containerHeight: number,
  panelWidth: number,
  panelHeight: number,
  padding: number,
  insets?: MapOverlayInsets | null,
): PanelArea {
  const fit = (start: number, end: number, size: number, panelSize: number) => {
    const safeStart = Math.max(0, finiteOr(start, 0));
    const safeSize = size - safeStart - Math.max(0, finiteOr(end, 0));
    return safeSize >= panelSize + padding * 2
      ? { offset: safeStart, size: safeSize }
      : { offset: 0, size };
  };
  const x = fit(insets?.left ?? 0, insets?.right ?? 0, containerWidth, panelWidth);
  const y = fit(insets?.top ?? 0, insets?.bottom ?? 0, containerHeight, panelHeight);
  return { left: x.offset, top: y.offset, width: x.size, height: y.size };
}

export function resolvePanelPlacement(
  anchorX: number,
  anchorY: number,
  containerWidth: number,
  containerHeight: number,
): PanelPlacement {
  return {
    horizontal: anchorX <= containerWidth / 2 ? 'right' : 'left',
    vertical: anchorY <= containerHeight / 2 ? 'down' : 'up',
  };
}

export function computePanelPosition(
  anchorX: number,
  anchorY: number,
  panelWidth: number,
  panelHeight: number,
  containerWidth: number,
  containerHeight: number,
  padding: number,
  placement: PanelPlacement,
): { left: number; top: number } {
  const safePadding = finiteOr(padding, 0);
  const safeAnchorX = finiteOr(anchorX, safePadding);
  const safeAnchorY = finiteOr(anchorY, safePadding);
  const safePanelWidth = Math.max(0, finiteOr(panelWidth, 0));
  const safePanelHeight = Math.max(0, finiteOr(panelHeight, 0));
  const safeContainerWidth = Math.max(safePadding * 2, finiteOr(containerWidth, safePanelWidth + safePadding * 2));
  const safeContainerHeight = Math.max(safePadding * 2, finiteOr(containerHeight, safePanelHeight + safePadding * 2));
  const rawLeft = placement.horizontal === 'right'
    ? safeAnchorX
    : safeAnchorX - safePanelWidth;
  const rawTop = placement.vertical === 'down'
    ? safeAnchorY
    : safeAnchorY - safePanelHeight;

  return {
    left: Math.max(safePadding, Math.min(rawLeft, Math.max(safePadding, safeContainerWidth - safePanelWidth - safePadding))),
    top: Math.max(safePadding, Math.min(rawTop, Math.max(safePadding, safeContainerHeight - safePanelHeight - safePadding))),
  };
}