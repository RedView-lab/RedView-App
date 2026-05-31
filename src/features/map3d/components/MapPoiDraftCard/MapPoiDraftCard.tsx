import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

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
import { computePanelPosition } from '../panelPlacement';

const CARD_WIDTH = 200;
const EDGE_PADDING = 8;

function isFiniteCoordinate(value: number): boolean {
  return Number.isFinite(value);
}

interface MapPoiDraftCardProps {
  draft: MapPoiDraft;
  map: MapboxMap | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onDraftChange: (nextDraft: MapPoiDraft) => void;
  onAction: (payload: MapPoiDraftActionPayload) => void;
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
        pointerEvents: 'auto',
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
          fontSize: 13,
          fontWeight: danger ? 400 : 600,
          lineHeight: '17px',
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
  map,
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

  const syncCardPosition = useCallback(() => {
    if (!cardRef.current || !containerRef.current) return;

    const cardRect = cardRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const fallbackPoint = {
      x: draft.screenPoint.x - containerRect.left,
      y: draft.screenPoint.y - containerRect.top,
    };
    const projectedPoint = map
      ? map.project([draft.point.lng, draft.point.lat])
      : fallbackPoint;
    const anchorX = isFiniteCoordinate(projectedPoint.x) ? projectedPoint.x : fallbackPoint.x;
    const anchorY = isFiniteCoordinate(projectedPoint.y) ? projectedPoint.y : fallbackPoint.y;

    if (
      !isFiniteCoordinate(anchorX)
      || !isFiniteCoordinate(anchorY)
      || !isFiniteCoordinate(cardRect.width)
      || !isFiniteCoordinate(cardRect.height)
      || !isFiniteCoordinate(containerRect.width)
      || !isFiniteCoordinate(containerRect.height)
    ) {
      return;
    }

    const nextPosition = computePanelPosition(
      anchorX,
      anchorY,
      cardRect.width,
      cardRect.height,
      containerRect.width,
      containerRect.height,
      EDGE_PADDING,
      draft.placement,
    );

    setPosition((current) => (
      current.left === nextPosition.left && current.top === nextPosition.top
        ? current
        : nextPosition
    ));
  }, [containerRef, draft, map]);

  useLayoutEffect(() => {
    syncCardPosition();
  }, [categoryOpen, syncCardPosition]);

  useEffect(() => {
    if (!map) return;

    const handleMove = () => {
      syncCardPosition();
    };

    map.on('move', handleMove);
    map.on('resize', handleMove);

    return () => {
      map.off('move', handleMove);
      map.off('resize', handleMove);
    };
  }, [map, syncCardPosition]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (cardRef.current?.contains(target)) return;
      onAction({ action: 'close', draft });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onAction({ action: 'close', draft });
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
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
  const metadataColor = 'rgba(255,255,255,0.64)';

  return (
    <div
      ref={cardRef}
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
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        borderBottomLeftRadius: 0,
        boxShadow: '0 12px 36px rgba(0,0,0,0.38)',
        color: '#ffffff',
        fontFamily: 'Rethink Sans, system-ui, -apple-system, Segoe UI, sans-serif',
        pointerEvents: 'none',
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
            pointerEvents: 'auto',
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
            fontSize: 12,
            fontWeight: 500,
            lineHeight: '16px',
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
            pointerEvents: 'auto',
          }}
        >
          <GlobeGlyph />
        </button>
      </div>

      <div aria-hidden style={{ position: 'relative', width: '100%', height: 1, background: 'rgba(255,255,255,0.12)' }} />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0, width: '100%', color: metadataColor }}>
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
              color: 'currentColor',
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
              color: 'currentColor',
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
              color: metadataColor,
              cursor: 'pointer',
              flex: '0 0 auto',
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
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 'normal',
            color: metadataColor,
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
              pointerEvents: 'auto',
            }}
          >
            <span
              style={{
                minWidth: 0,
                flex: '1 1 0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 13,
                fontWeight: 600,
                lineHeight: '17px',
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
                pointerEvents: 'auto',
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
                    <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '16px' }}>
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