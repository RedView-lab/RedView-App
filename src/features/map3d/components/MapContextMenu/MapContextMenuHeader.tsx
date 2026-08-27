import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { GlobeGlyph } from './icons';
import { useAppI18n } from '@/shared/i18n';

interface MapContextMenuHeaderProps {
  titleLabel: string;
  onOpenStreetView: () => void;
}

export function MapContextMenuHeader({
  titleLabel,
  onOpenStreetView,
}: MapContextMenuHeaderProps) {
  const { t } = useAppI18n();

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 32 }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          color: '#ffffff',
          flex: '0 0 auto',
        }}
      >
        <SvgV2Icon name="star-01.svg" size={16} />
      </span>

      <span
        style={{
          minWidth: 0,
          flex: '1 1 0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 13,
          fontWeight: 500,
          lineHeight: '17px',
          color: '#ffffff',
        }}
      >
        {titleLabel}
      </span>

      <button
        type="button"
        onClick={onOpenStreetView}
        aria-label={t('Ouvrir Street View')}
        title={t('Ouvrir Street View')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'rgba(255,255,255,0.92)',
          cursor: 'pointer',
          flex: '0 0 auto',
          pointerEvents: 'auto',
        }}
      >
        <GlobeGlyph />
      </button>
    </div>
  );
}
