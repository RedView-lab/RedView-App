export interface PanelPlacement {
  horizontal: 'right' | 'left';
  vertical: 'down' | 'up';
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
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