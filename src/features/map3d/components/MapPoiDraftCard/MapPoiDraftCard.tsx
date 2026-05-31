import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { POI_CATEGORIES, POI_LABELS, type PoiCategory } from '@/features/poi/types';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import {
  CopyButtonIcon,
  ElevationGlyph,
  FinishGlyph,
  GlobeGlyph,
  SlopeGlyph,
  StartGlyph,
  SurfaceGlyph,
  WaypointGlyph,
} from '../MapContextMenu/icons';
import { copyTextToClipboard } from '../MapContextMenu/utils';
import type { MapPoiDraft, MapPoiDraftActionPayload } from './types';

const CARD_WIDTH = 200;
const EDGE_PADDING = 8;

interface MapPoiDraftCardProps {
  draft: MapPoiDraft;
  containerRef: RefObject<HTMLDivElement | null>;
  onDraftChange: (nextDraft: MapPoiDraft) => void;
  onAction: (payload: MapPoiDraftActionPayload) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function ActionRow({
  label,
  icon,
  onClick,
  danger = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        minWidth: 80,
        minHeight: 32,
        padding: 4,
        border: 'none',
        borderRadius: 6,
        background: hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
        cursor: 'pointer',
        color: '#ffffff',
        textAlign: 'left',
      }}
    >
      {icon}
      <span
        style={{
          minWidth: 0,
          flex: '1 1 0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 14,
          fontWeight: danger ? 400 : 600,
          lineHeight: '18px',
          color: '#ffffff',
        }}
      >
        {label}
      </span>
    </button>
  );
}

function DeleteGlyph() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        color: '#ffffff',
      }}
    >
      <SvgV2Icon name="trash-03.svg" size={16} />
    </span>
  );
}

export function MapPoiDraftCard({
  draft,
  containerRef,
  onDraftChange,
  onAction,
}: MapPoiDraftCardProps) {
  const { t } = useAppI18n();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ left: EDGE_PADDING, top: EDGE_PADDING });

  const categoryOptions = useMemo(() => {
    return POI_CATEGORIES.map((category) => ({
      value: category,
      label: POI_LABELS[category],
    }));
  }, []);

  useLayoutEffect(() => {
    if (!cardRef.current || !containerRef.current) return;
    const cardRect = cardRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const rawLeft = draft.screenPoint.x - containerRect.left;
    const rawTop = draft.screenPoint.y - containerRect.top;

    setPosition({
      left: clamp(
        rawLeft,
        EDGE_PADDING,
        Math.max(EDGE_PADDING, containerRect.width - cardRect.width - EDGE_PADDING),
      ),
      top: clamp(
        rawTop,
        EDGE_PADDING,
        Math.max(EDGE_PADDING, containerRect.height - cardRect.height - EDGE_PADDING),
      ),
    });
  }, [containerRef, draft, categoryOpen]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (cardRef.current?.contains(target)) return;
      onAction({ action: 'close', draft });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onAction({ action: 'close', draft });
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [draft, onAction]);

  const handleCopyCoordinates = useCallback(async () => {
    try {
      await copyTextToClipboard(draft.point.coordinatesLabel);
      setCopied(true);
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 1200);
    } catch {
      setCopied(false);
    }
  }, [draft.point.coordinatesLabel]);

  useEffect(() => () => {
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const handleOpenStreetView = useCallback(() => {
    onAction({ action: 'open-street-view', draft });
    const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(`${draft.point.lat},${draft.point.lng}`)}`;
    window.open(streetViewUrl, '_blank', 'noopener,noreferrer');
  }, [draft, onAction]);

  const slopeLabel = draft.slopePct == null ? null : `${Math.abs(draft.slopePct)}%`;
  const elevationLabel = draft.point.elevationMeters == null ? '—' : `${Math.round(draft.point.elevationMeters)}m`;
  const surfaceLabel = draft.surfaceLabel ?? draft.point.surfaceLabel ?? '—';
  const infoCategoryLabel = draft.point.categoryLabel ?? draft.roadTypeLabel ?? t('Position');
  const title = draft.name?.trim() || draft.point.title?.trim() || t('Nouveau POI');
  const categoryLabel = draft.category ? POI_LABELS[draft.category] : t('Sélectionner');

  return (
    <div
      ref={cardRef}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left,
        zIndex: 35,
        width: CARD_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.08)',
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        borderBottomLeftRadius: 0,
        boxShadow: '0 12px 36px rgba(0,0,0,0.38)',
        color: '#ffffff',
        fontFamily: 'Rethink Sans, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.74)" />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 32 }}>
        <button
          type="button"
          aria-label={t('Favori')}
          title={t('Favori')}
          onClick={() => {
            onDraftChange({ ...draft, favorite: !draft.favorite });
            onAction({ action: 'toggle-favorite', draft: { ...draft, favorite: !draft.favorite } });
          }}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: draft.favorite ? '#ffffff' : 'rgba(255,255,255,0.64)',
            cursor: 'pointer',
          }}
        >
          <SvgV2Icon name="star-01.svg" size={16} />
        </button>

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
          {title}
        </span>

        <button
          type="button"
          aria-label={t('Ouvrir Street View')}
          title={t('Ouvrir Street View')}
          onClick={handleOpenStreetView}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 4,
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.96)',
            cursor: 'pointer',
          }}
        >
          <GlobeGlyph />
        </button>
      </div>

      <div aria-hidden style={{ position: 'relative', width: '100%', height: 1, background: 'rgba(255,255,255,0.12)' }} />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0, width: '100%', color: '#ffffff' }}>
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
              color: '#ffffff',
            }}
          >
            {infoCategoryLabel}
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
              color: '#ffffff',
            }}
          >
            {draft.point.coordinatesLabel}
          </span>

          <button
            type="button"
            onClick={() => {
              void handleCopyCoordinates();
            }}
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
              color: 'rgba(255,255,255,0.92)',
              cursor: 'pointer',
              flex: '0 0 auto',
            }}
          >
            <CopyButtonIcon copied={copied} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
          {slopeLabel ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <SlopeGlyph />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  fontStyle: 'italic',
                  lineHeight: '16px',
                  color: '#ffffff',
                }}
              >
                {slopeLabel}
              </span>
            </div>
          ) : null}

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <ElevationGlyph />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                fontStyle: 'italic',
                lineHeight: '16px',
                color: '#ffffff',
              }}
            >
              {elevationLabel}
            </span>
          </div>

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
                color: '#ffffff',
              }}
            >
              {surfaceLabel}
            </span>
          </div>
        </div>
      </div>

      <div aria-hidden style={{ position: 'relative', width: '100%', height: 1, background: 'rgba(255,255,255,0.12)' }} />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 6, width: '100%' }}>
        <span
          style={{
            flex: '0 0 auto',
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 'normal',
            color: 'rgba(255,255,255,0.64)',
          }}
        >
          POI
        </span>

        <div style={{ position: 'relative', minWidth: 0, flex: '1 1 0' }}>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={categoryOpen}
            onClick={() => setCategoryOpen((open) => !open)}
            style={{
              width: '100%',
              minHeight: 30,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: 4,
              borderRadius: 5,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                minWidth: 0,
                flex: '1 1 0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 14,
                fontWeight: 600,
                lineHeight: '18px',
                color: draft.category ? '#ffffff' : 'rgba(255,255,255,0.64)',
                textAlign: 'left',
              }}
            >
              {categoryLabel}
            </span>
            <SvgV2Icon name="chevron-down.svg" size={20} />
          </button>

          {categoryOpen ? (
            <div
              role="listbox"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                zIndex: 2,
                maxHeight: 180,
                overflowY: 'auto',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(10, 10, 12, 0.92)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
              }}
            >
              {categoryOptions.map((option) => {
                const selected = draft.category === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      const nextDraft = { ...draft, category: option.value as PoiCategory };
                      onDraftChange(nextDraft);
                      onAction({ action: 'change-category', draft: nextDraft });
                      setCategoryOpen(false);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '8px 10px',
                      border: 'none',
                      background: selected ? 'rgba(255,255,255,0.08)' : 'transparent',
                      color: '#ffffff',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 'normal' }}>
                      {option.label}
                    </span>
                    {selected ? <SvgV2Icon name="check.svg" size={14} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <ActionRow
        label={t('Démarrer ici')}
        icon={<StartGlyph />}
        onClick={() => onAction({ action: 'start-here', draft })}
      />
      <ActionRow
        label={t('Ajouter une étape')}
        icon={<WaypointGlyph />}
        onClick={() => onAction({ action: 'add-waypoint', draft })}
      />
      <ActionRow
        label={t('Finir ici')}
        icon={<FinishGlyph />}
        onClick={() => onAction({ action: 'finish-here', draft })}
      />
      <ActionRow
        label={t('Supprimer')}
        icon={<DeleteGlyph />}
        onClick={() => onAction({ action: 'delete', draft })}
        danger
      />
    </div>
  );
}