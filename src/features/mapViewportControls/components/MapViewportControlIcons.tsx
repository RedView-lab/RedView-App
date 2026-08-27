import type { CSSProperties } from 'react';
import { AssetIcon, type AssetIconProps } from '@/shared/components/AssetIcon';

export function IconMaximize({ size = 18, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/svgv2/icone/scale-01.svg" size={size} {...rest} />
  );
}

export function IconZoomIn({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/svgv2/icone/zoom-in.svg" size={size} {...rest} />
  );
}

export function IconZoomOut({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/svgv2/icone/zoom-out.svg" size={size} {...rest} />
  );
}

export function IconCompass({ size = 20, rotation = 0, ...rest }: AssetIconProps & { rotation?: number }) {
  return (
    <AssetIcon
      src="/svgv2/icone/compass-03.svg"
      size={size}
      style={{ transform: `rotate(${rotation}deg)`, transformOrigin: 'center' } as CSSProperties}
      {...rest}
    />
  );
}

export function IconInfo({ size = 16, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/svgv2/icone/info-circle.svg" size={size} {...rest} />
  );
}

export function IconPolygonZone({ size = 18, ...rest }: AssetIconProps) {
  return (
    <AssetIcon src="/svgv2/icone/polygon-zone.svg" size={size} {...rest} />
  );
}