import type { CSSProperties } from 'react';
import { AssetIcon, type AssetIconProps } from '@/shared/components/AssetIcon';

export function IconMaximize({ size = 18, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/icons/ui/scale-01.svg" size={size} {...rest} />
  );
}

export function IconZoomIn({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/icons/ui/zoom-in.svg" size={size} {...rest} />
  );
}

export function IconZoomOut({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/icons/ui/zoom-out.svg" size={size} {...rest} />
  );
}

export function IconCompass({ size = 20, rotation = 0, ...rest }: AssetIconProps & { rotation?: number }) {
  return (
    <AssetIcon
      src="/icons/ui/compass-03.svg"
      size={size}
      style={{ transform: `rotate(${rotation}deg)`, transformOrigin: 'center' } as CSSProperties}
      {...rest}
    />
  );
}

export function IconInfo({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/icons/ui/info-circle.svg" size={size} {...rest} />
  );
}

/** Bouton du panneau droit (calques / réglages carte). */
export function IconPanelLayers({ size = 18, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/icons/ui/layers-three-01.svg" size={size} {...rest} />
  );
}

