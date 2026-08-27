import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { PoiCategory } from '@/features/poi/types';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import { useProjectStoreOptional } from '@/features/itineraryPanel';

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
import { ActionRow, DeleteGlyph } from './ActionRow';
import { CategorySelector } from './CategorySelector';
import { usePoiDraftCardPosition } from './usePoiDraftCardPosition';

const CARD_WIDTH = 200;

interface MapPoiDraftCardProps {
  draft: MapPoiDraft;
  map: MapboxMap | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onDraftChange: (nextDraft: MapPoiDraft) => void;
  onAction: (payload: MapPoiDraftActionPayload) => void;
}

/**
 * Carte flottante interactive ancrée sur un point d'intérêt (POI) en cours d'édition sur la carte 3D.
 */
export function MapPoiDraftCard({
  draft,
  map,
  containerRef,
  onDraftChange,
  onAction,
}: MapPoiDraftCardProps) {
  const { t } = useAppI18n();
  const projectStore = useProjectStoreOptional();
  const project = projectStore?.project;

  const hasStartPoint = useMemo(() => {
    if (!project || project.itineraries.length === 0) return false;
    const activeItinerary =
      project.itineraries.find((it) => it.id === project.activeItineraryId) ??
      project.itineraries[0];
    if (!activeItinerary) return false;
    if (activeItinerary.gpxRoute && activeItinerary.gpxRoute.points.length > 0) return true;
    const start = activeItinerary.timeline.find((row) => row.kind === 'start');
    return Boolean(start && start.lat != null && start.lon != null);
  }, [project]);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  const position = usePoiDraftCardPosition({
    draft,
    map,
    cardRef,
    containerRef,
  });

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

    let clickListenerAttached = false;
    const animationFrameId = window.requestAnimationFrame(() => {
      document.addEventListener('click', handleClick);
      clickListenerAttached = true;
    });

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
      if (clickListenerAttached) {
        document.removeEventListener('click', handleClick);
      }
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

      <CategorySelector
        category={draft.category}
        onChange={(nextCat: PoiCategory) => {
          const nextDraft = { ...draft, category: nextCat };
          onDraftChange(nextDraft);
          onAction({ action: 'change-category', draft: nextDraft });
        }}
        metadataColor={metadataColor}
      />

      <ActionRow
        label={t('Démarrer ici')}
        icon={<StartGlyph />}
        onClick={() => onAction({ action: 'start-here', draft })}
      />
      {hasStartPoint ? (
        <>
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
        </>
      ) : null}
      <ActionRow
        label={t('Supprimer')}
        icon={<DeleteGlyph />}
        onClick={() => onAction({ action: 'delete', draft })}
        danger
      />
    </div>
  );
}