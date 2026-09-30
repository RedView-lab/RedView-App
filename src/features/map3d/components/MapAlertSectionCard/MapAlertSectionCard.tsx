import { useCallback, useEffect, useRef, useState } from 'react';

import type { SteepAlertKind } from '@/features/itineraryPanel/types';
import { useAppI18n } from '@/shared/i18n';

import '@/features/poi/styles/floating-markers.css';
import './MapAlertSectionCard.css';

import { CopyButtonIcon, ElevationGlyph, SlopeGlyph, SurfaceGlyph } from '../MapContextMenu/icons';
import { copyTextToClipboard } from '../MapContextMenu/utils';
import type { MapAlertSection, MapAlertSectionActionPayload } from './types';

const ICONS = {
  alert: '/svgv2/icone/search-filter-alertes.svg',
  globe: '/right-click-icons/globe-06.svg',
  chevron: '/svgv2/icone/chevron-down.svg',
  removeFromRoute: '/svgv2/icone/corner-up-right.svg',
  ignore: '/svgv2/icone/x.svg',
} as const;

const KIND_OPTIONS: Array<{ value: SteepAlertKind; label: string }> = [
  { value: 'alert', label: 'Alerte' },
  { value: 'warning', label: 'Attention' },
  { value: 'info', label: 'Info' },
];

function AlertBadge({ kind }: { kind: SteepAlertKind }) {
  return (
    <span className={`rv-alert-popup__badge rv-alert-popup__badge--${kind}`} aria-hidden>
      <img src={ICONS.alert} alt="" draggable={false} />
    </span>
  );
}

interface MapAlertSectionCardProps {
  section: MapAlertSection;
  onAction: (payload: MapAlertSectionActionPayload) => void;
}

/**
 * Contenu de la popup Mapbox d'un tronçon « Alertes » (pente ≥ 12 % sur ≥ 100 m).
 * Reprend le gabarit et les classes du menu POI (`rv-poi-popup__*`).
 */
export function MapAlertSectionCard({ section, onAction }: MapAlertSectionCardProps) {
  const { t } = useAppI18n();
  const [copied, setCopied] = useState(false);
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const kindWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    if (!kindMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (kindWrapRef.current?.contains(event.target as Node)) return;
      setKindMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [kindMenuOpen]);

  const handleCopyCoordinates = useCallback(async () => {
    try {
      await copyTextToClipboard(section.coordinatesLabel);
      setCopied(true);
      if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 1200);
    } catch {
      setCopied(false);
    }
  }, [section.coordinatesLabel]);

  const handleOpenStreetView = useCallback(() => {
    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(`${section.lat},${section.lng}`)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [section.lat, section.lng]);

  const kindLabel = KIND_OPTIONS.find((option) => option.value === section.kind)?.label ?? 'Alerte';
  const slopeTitle = `${t('Pente max')} ${Math.round(section.maxGradientPct)} % · ${t('moyenne')} ${Math.round(section.avgGradientPct)} % · ${Math.round(section.lengthM)} m`;
  const elevationLabel = section.elevationM == null ? '—' : `${Math.round(section.elevationM)}m`;

  return (
    <div className="rv-poi-popup__panel rv-alert-popup">
      <div className="rv-poi-popup__header">
        <span className="rv-poi-popup__icon-btn" aria-hidden>
          <AlertBadge kind={section.kind} />
        </span>
        <div className="rv-poi-popup__title">{t('Section pentue')}</div>
        <button
          type="button"
          className="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost"
          aria-label={t('Ouvrir Street View')}
          title={t('Ouvrir Street View')}
          onClick={handleOpenStreetView}
        >
          <img src={ICONS.globe} alt="" className="rv-poi-popup__icon" />
        </button>
      </div>

      <div className="rv-poi-popup__divider" />

      <div className="rv-alert-popup__meta">
        <div className="rv-alert-popup__meta-row">
          <span className="rv-alert-popup__meta-text rv-alert-popup__meta-text--lead">
            {section.roadTypeLabel ?? t('Position')}
          </span>
          <span className="rv-alert-popup__meta-text rv-alert-popup__meta-text--fill">{section.coordinatesLabel}</span>
          <button
            type="button"
            className="rv-alert-popup__copy"
            aria-label={t('Copier les coordonnées')}
            title={t('Copier les coordonnées')}
            onClick={() => {
              void handleCopyCoordinates();
            }}
          >
            <CopyButtonIcon copied={copied} />
          </button>
        </div>

        <div className="rv-alert-popup__meta-row rv-alert-popup__meta-row--spread">
          <span className="rv-alert-popup__meta-item" title={slopeTitle}>
            <SlopeGlyph />
            <span className="rv-alert-popup__meta-text">{`${Math.round(section.maxGradientPct)}%`}</span>
          </span>
          <span className="rv-alert-popup__meta-item">
            <ElevationGlyph />
            <span className="rv-alert-popup__meta-text">{elevationLabel}</span>
          </span>
          <span className="rv-alert-popup__meta-item">
            <SurfaceGlyph color={section.surfaceColor ?? 'rgba(255,255,255,0.4)'} />
            <span className="rv-alert-popup__meta-text">{section.surfaceLabel ?? '—'}</span>
          </span>
        </div>

        <div className="rv-alert-popup__meta-row rv-alert-popup__meta-row--spread">
          <span className="rv-alert-popup__swatch" style={{ background: section.itineraryColor }} aria-hidden />
          <span className="rv-alert-popup__meta-text rv-alert-popup__meta-text--upright">{section.distanceLabel}</span>
          {section.durationLabel ? (
            <span className="rv-alert-popup__meta-text rv-alert-popup__meta-text--upright">{section.durationLabel}</span>
          ) : null}
          {section.clockLabel ? (
            <span className="rv-alert-popup__meta-text rv-alert-popup__meta-text--upright">{section.clockLabel}</span>
          ) : null}
        </div>
      </div>

      <div className="rv-poi-popup__divider" />

      <div className="rv-poi-popup__field-row">
        <div className="rv-poi-popup__field-label">{t('Type')}</div>
        <div className="rv-poi-popup__select-wrap" ref={kindWrapRef}>
          <button
            type="button"
            className="rv-poi-popup__select"
            aria-label={t('Type')}
            aria-haspopup="listbox"
            aria-expanded={kindMenuOpen}
            onClick={() => setKindMenuOpen((open) => !open)}
          >
            <span className="rv-poi-popup__type-icon-wrap">
              <AlertBadge kind={section.kind} />
            </span>
            <span className="rv-poi-popup__select-value">{t(kindLabel)}</span>
            <img src={ICONS.chevron} alt="" className="rv-poi-popup__chevron" />
          </button>
          {kindMenuOpen ? (
            <div className="rv-dropdown rv-poi-popup__dropdown" role="listbox" aria-label={t('Type')}>
              {KIND_OPTIONS.map((option) => {
                const selected = option.value === section.kind;
                return (
                  <div
                    key={option.value}
                    className={`rv-dropdown__item rv-poi-popup__dropdown-option${selected ? ' is-selected' : ''}`}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setKindMenuOpen(false);
                      if (!selected) onAction({ action: 'change-kind', section, kind: option.value });
                    }}
                  >
                    <span className="rv-dropdown__label">{t(option.label)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div className="rv-poi-popup__divider" />

      {section.canRemoveFromRoute ? (
        <button
          type="button"
          className="rv-poi-popup__action-row"
          onClick={() => onAction({ action: 'remove-from-route', section })}
        >
          <span className="rv-poi-popup__utility-icon-wrap" aria-hidden>
            <img src={ICONS.removeFromRoute} alt="" className="rv-poi-popup__utility-icon" />
          </span>
          <span className="rv-poi-popup__action-label">{t('Retirer du parcours')}</span>
        </button>
      ) : null}
      <button
        type="button"
        className="rv-poi-popup__action-row"
        onClick={() => onAction({ action: 'ignore', section })}
      >
        <span className="rv-poi-popup__utility-icon-wrap" aria-hidden>
          <img src={ICONS.ignore} alt="" className="rv-poi-popup__utility-icon rv-alert-popup__ignore-icon" />
        </span>
        <span className="rv-poi-popup__action-label">{t('Ignorer')}</span>
      </button>
    </div>
  );
}
