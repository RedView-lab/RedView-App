import { SunGlyph, ThermometerGlyph, WindGlyph } from './icons';
import type { MapContextMenuOverlayDetail } from './types';

interface OverlayDetailRowProps {
  detail: MapContextMenuOverlayDetail;
}

export function OverlayDetailRow({ detail }: OverlayDetailRowProps) {
  const icon = detail.icon === 'sun'
    ? <SunGlyph />
    : detail.icon === 'thermometer'
      ? <ThermometerGlyph />
      : <WindGlyph />;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24, color: 'rgba(255,255,255,0.64)' }}>
      {icon}
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontWeight: 500,
          fontStyle: 'italic',
          lineHeight: '16px',
          color: 'currentColor',
        }}
      >
        {detail.label}
      </span>
    </div>
  );
}
