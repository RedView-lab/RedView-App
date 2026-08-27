import { useMemo } from 'react';
import { useAppI18n } from '@/shared/i18n';
import {
  ClockGlyph,
  CopyButtonIcon,
  ElevationGlyph,
  SlopeGlyph,
  SurfaceGlyph,
} from './icons';
import { OverlayDetailRow } from './OverlayDetailRow';
import type { MapContextMenuPoint } from './types';

interface MapContextMenuMetadataProps {
  point: MapContextMenuPoint;
  copied: boolean;
  onCopyCoordinates: () => void;
}

export function MapContextMenuMetadata({
  point,
  copied,
  onCopyCoordinates,
}: MapContextMenuMetadataProps) {
  const { t } = useAppI18n();
  const metadataColor = 'rgba(255,255,255,0.64)';

  const categoryLabel = point.categoryLabel?.trim() || t('Position');
  const elevationLabel = useMemo(() => {
    if (point.elevationMeters == null) return '...';
    return `${Math.round(point.elevationMeters)}m`;
  }, [point.elevationMeters]);

  const slopeLabel = useMemo(() => {
    if (point.slopePct == null) return null;
    return `${Math.abs(point.slopePct)}%`;
  }, [point.slopePct]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, paddingBlock: 4 }}>
        <span
          style={{
            minWidth: 0,
            flex: '0 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            fontWeight: 500,
            fontStyle: 'italic',
            lineHeight: '16px',
            color: metadataColor,
          }}
        >
          {categoryLabel}
        </span>

        <span
          style={{
            minWidth: 0,
            flex: '1 1 0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            fontWeight: 500,
            fontStyle: 'italic',
            lineHeight: '16px',
            color: metadataColor,
          }}
        >
          {point.coordinatesLabel}
        </span>

        <button
          type="button"
          onClick={onCopyCoordinates}
          aria-label={t('Copier les coordonnées')}
          title={t('Copier les coordonnées')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: metadataColor,
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          <CopyButtonIcon copied={copied} />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
        {slopeLabel ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, color: metadataColor }}>
            <SlopeGlyph />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                fontStyle: 'italic',
                lineHeight: '16px',
                color: 'currentColor',
              }}
            >
              {slopeLabel}
            </span>
          </div>
        ) : null}

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, color: metadataColor }}>
          <ElevationGlyph />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              fontStyle: 'italic',
              lineHeight: '16px',
              color: 'currentColor',
            }}
          >
            {elevationLabel}
          </span>
        </div>

        {point.surfaceLabel ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <SurfaceGlyph />
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
                color: metadataColor,
              }}
            >
              {point.surfaceLabel}
            </span>
          </div>
        ) : null}
      </div>

      {point.openingHoursLabel ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24, color: metadataColor }}>
          <ClockGlyph />
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
            {point.openingHoursLabel}
          </span>
        </div>
      ) : null}

      {point.overlayDetails.map((detail) => (
        <OverlayDetailRow key={detail.id} detail={detail} />
      ))}
    </div>
  );
}
