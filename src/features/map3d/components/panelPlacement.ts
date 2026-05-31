export interface PanelPlacement {
  horizontal: 'right' | 'left';
  vertical: 'down' | 'up';
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
  const rawLeft = placement.horizontal === 'right'
    ? anchorX
    : anchorX - panelWidth;
  const rawTop = placement.vertical === 'down'
    ? anchorY
    : anchorY - panelHeight;

  return {
    left: Math.max(padding, Math.min(rawLeft, Math.max(padding, containerWidth - panelWidth - padding))),
    top: Math.max(padding, Math.min(rawTop, Math.max(padding, containerHeight - panelHeight - padding))),
  };
}