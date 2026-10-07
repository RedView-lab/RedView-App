import { useMemo, useRef, useState, memo, type MouseEvent } from 'react';
import { useProjectStoreOptional, type TimelineAddItemKind } from '@/features/itineraryPanel';
import { TimelineKindMenu } from '@/features/itineraryPanel/sections/timeline/TimelineKindMenu';
import { TIMELINE_ADD_MENU_OPTIONS } from '@/features/itineraryPanel/sections/timeline/timelineAddMenuOptions';
import { useHorizontalScrollOverflow } from '@/shared/hooks/useHorizontalScrollOverflow';
import { useAppI18n } from '@/shared/i18n';
import { trackAnalyticsEvent, type MapTool } from '@/shared/lib/analytics';
import { variantModifierLabel } from '@/shared/lib/platform';
import { useRouteMergeToolOptional } from '../../routeMerge';
import { useRouteSplitToolOptional } from '../../routeSplit';
import { useTraceToolOptional } from '../../tracer';
import { useForbiddenZoneToolOptional } from '../../forbiddenZones';
import { useChartPlacementToolOptional } from '../../chartPlacement';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { IconChevronDown } from '../CenterPanelIcons';
import { useAnalysisFlyover } from '../../flyover';
import { CommentToolbarButton, useCommentToolOptional } from '@/features/comments';
import {
  IconClockRewind,
  IconCursor,
  IconPause,
  IconPencilLine,
  IconPlay,
  IconPlusCircle,
  IconRedo,
  IconScissors,
  IconSkip,
  IconSlashOctagon,
  IconSwitchHorizontal,
  IconTrash,
  IconUndo,
} from './icons';
import { ToolbarIconButton } from './ToolbarIconButton';

interface CenterPanelToolbarProps {
  /** Visibility of the center analysis panel this toolbar belongs to. */
  isPanelVisible?: boolean;
  /** Collapses / restores the center panel. */
  onTogglePanel?: () => void;
}

export const CenterPanelToolbar = memo(function CenterPanelToolbar({
  isPanelVisible = true,
  onTogglePanel,
}: CenterPanelToolbarProps) {
  const { t } = useAppI18n();
  // Half-screen window: the track overflows, wheel scrolls it, edges fade.
  const viewportRef = useRef<HTMLDivElement>(null);
  useHorizontalScrollOverflow(viewportRef);
  const store = useProjectStoreOptional();
  const routeMergeTool = useRouteMergeToolOptional();
  const routeSplitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();
  const chartPlacementTool = useChartPlacementToolOptional();
  const commentTool = useCommentToolOptional();
  const [toolbarStatus, setToolbarStatus] = useState<string | null>(null);
  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);
  const {
    canPlay,
    canSlowDown,
    canSpeedUp,
    distanceLabel,
    isPlaying,
    resetPlayback,
    slowDown,
    speedUp,
    timeLabel,
    togglePlayback,
  } = useAnalysisFlyover();
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const searchPlaceholder = t('Rechercher un lieu');
  const canDeleteActiveRoute = Boolean(
    activeItinerary && (
      (activeItinerary.gpxRoute?.points.length ?? 0) > 0 ||
      activeItinerary.timeline.some((item) =>
        item.kind === 'waypoint' ||
        item.kind === 'pause' ||
        item.kind === 'poi' ||
        item.lat != null ||
        item.lon != null ||
        (item.kind === 'start' && item.label !== searchPlaceholder && item.label !== 'Rechercher un lieu') ||
        (item.kind === 'end' && item.label !== searchPlaceholder && item.label !== 'Rechercher un lieu'),
      ) ||
      activeItinerary.metrics ||
      activeItinerary.poiFeatures?.length ||
      activeItinerary.prediction
    ),
  );
  const trackToolSelected = (tool: MapTool) => trackAnalyticsEvent({ name: 'map_tool_selected', data: { tool } });
  const handleDeleteActiveRoute = () => {
    if (!store || !activeItinerary) return;
    trackAnalyticsEvent({ name: 'route_action', data: { action: 'delete' } });
    store.clearItineraryRoute(activeItinerary.id);
    setToolbarStatus(t('Trace supprimée'));
  };
  const canPlaceOnChart = chartPlacementTool?.canPlace ?? false;
  const placementArmed = chartPlacementTool?.armedKind != null;
  const placementStatusMessage = chartPlacementTool?.statusMessage ?? null;
  const addButtonTitle = placementArmed
    ? t('Annuler l’ajout')
    : canPlaceOnChart
      ? t('Ajouter un élément sur le graphique')
      : t('Tracez ou importez un itinéraire pour ajouter des éléments');
  // « Ajouter » : choix du type (menu « + » de la feuille de route), puis clic
  // sur le graphique à l'endroit voulu. Re-cliquer annule.
  const handleAddButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (placementArmed) {
      chartPlacementTool?.deactivate();
      setAddMenuAnchor(null);
      return;
    }
    const anchor = event.currentTarget;
    setAddMenuAnchor((current) => (current === anchor ? null : anchor));
  };
  const handleSelectAddKind = (kind: TimelineAddItemKind) => {
    routeMergeTool?.deactivate();
    routeSplitTool?.deactivate();
    traceTool?.deactivate();
    forbiddenZoneTool?.deactivate();
    commentTool?.deactivate();
    trackToolSelected('chart_placement');
    chartPlacementTool?.arm(kind);
    setToolbarStatus(null);
  };
  const reversibleRoute = activeItinerary?.gpxRoute ?? null;
  const reversibleTracePointCount = reversibleRoute?.points.length ?? 0;
  const canReverseTrace = reversibleTracePointCount > 1;
  const canSplitTrace = routeSplitTool?.canSplit ?? false;
  const splitStatusMessage = routeSplitTool?.statusMessage ?? null;
  const splitArmed = routeSplitTool?.armed ?? false;
  const canTrace = traceTool?.canTrace ?? false;
  const traceStatusMessage = traceTool?.statusMessage ?? null;
  const traceArmed = traceTool?.armed ?? false;
  const traceToolTitle = t(
    'Tracer : cliquez pour prolonger le tracé, glissez un point pour le déplacer, {{mod}} + clic pour créer une variante',
    { mod: variantModifierLabel() },
  );
  const canEditForbiddenZone = forbiddenZoneTool?.canEdit ?? false;
  const canUndoForbiddenZoneDraft = forbiddenZoneTool?.canUndoDraft ?? false;
  const canRedoForbiddenZoneDraft = forbiddenZoneTool?.canRedoDraft ?? false;
  const forbiddenZoneStatusMessage = forbiddenZoneTool?.statusMessage ?? null;
  const forbiddenZoneArmed = forbiddenZoneTool?.armed ?? false;
  const canUndoTraceEdit = forbiddenZoneArmed
    ? canUndoForbiddenZoneDraft
    : (store?.canUndoTraceEdit ?? false);
  const canRedoTraceEdit = forbiddenZoneArmed
    ? canRedoForbiddenZoneDraft
    : (store?.canRedoTraceEdit ?? false);
  const commentStatusMessage = commentTool?.statusMessage ?? null;
  const inlineToolbarStatus = useMemo(() => {
    if (commentStatusMessage) return commentStatusMessage;
    if (placementStatusMessage) return placementStatusMessage;
    if (splitStatusMessage) return splitStatusMessage;
    if (forbiddenZoneStatusMessage) return forbiddenZoneStatusMessage;
    if (traceStatusMessage) return traceStatusMessage;
    if (toolbarStatus) return toolbarStatus;
    return null;
  }, [
    commentStatusMessage,
    forbiddenZoneStatusMessage,
    placementStatusMessage,
    splitStatusMessage,
    traceStatusMessage,
    toolbarStatus,
  ]);

  // Le message de la barre concerne l'itinéraire actif : effacé quand il change.
  const activeItineraryId = activeItinerary?.id;
  const [statusItineraryId, setStatusItineraryId] = useState(activeItineraryId);
  if (statusItineraryId !== activeItineraryId) {
    setStatusItineraryId(activeItineraryId);
    setToolbarStatus(null);
  }

  const handleReverseTrace = () => {
    if (!store || !activeItinerary || !canReverseTrace) return;
    const reversed = store.reverseItineraryGpx(activeItinerary.id);
    if (reversed) trackAnalyticsEvent({ name: 'route_action', data: { action: 'reverse' } });
    setToolbarStatus(reversed ? t('Sens du GPX inversé') : t('Inversion indisponible pour cette trace'));
  };

  const handleToggleRouteSplit = () => {
    if (!splitArmed) {
      trackToolSelected('split');
      chartPlacementTool?.deactivate();
      routeMergeTool?.deactivate();
      traceTool?.deactivate();
      forbiddenZoneTool?.deactivate();
      commentTool?.deactivate();
    }
    routeSplitTool?.toggle();
    setToolbarStatus(null);
  };

  const handleToggleTrace = () => {
    if (!traceArmed) {
      trackToolSelected('tracer');
      chartPlacementTool?.deactivate();
      routeMergeTool?.deactivate();
      routeSplitTool?.deactivate();
      forbiddenZoneTool?.deactivate();
      commentTool?.deactivate();
    }
    traceTool?.toggle();
    setToolbarStatus(null);
  };

  const handleToggleForbiddenZone = () => {
    if (!forbiddenZoneArmed) {
      trackToolSelected('forbidden_zone');
      chartPlacementTool?.deactivate();
      routeMergeTool?.deactivate();
      routeSplitTool?.deactivate();
      traceTool?.deactivate();
      commentTool?.deactivate();
    }
    forbiddenZoneTool?.toggle();
    setToolbarStatus(null);
  };

  /** Commenter : les autres outils de la carte se désarment (un seul consomme les clics). */
  const handleBeforeArmComment = () => {
    chartPlacementTool?.deactivate();
    routeMergeTool?.deactivate();
    routeSplitTool?.deactivate();
    traceTool?.deactivate();
    forbiddenZoneTool?.deactivate();
    setToolbarStatus(null);
  };

  const handleUndoTraceEdit = () => {
    if (forbiddenZoneArmed) {
      if (!canUndoForbiddenZoneDraft) return;
      forbiddenZoneTool?.undoDraft();
      setToolbarStatus(null);
      return;
    }
    if (!store?.canUndoTraceEdit) return;
    trackAnalyticsEvent({ name: 'route_action', data: { action: 'undo' } });
    store.undoTraceEdit();
    setToolbarStatus(null);
  };

  const handleRedoTraceEdit = () => {
    if (forbiddenZoneArmed) {
      if (!canRedoForbiddenZoneDraft) return;
      forbiddenZoneTool?.redoDraft();
      setToolbarStatus(null);
      return;
    }
    if (!store?.canRedoTraceEdit) return;
    trackAnalyticsEvent({ name: 'route_action', data: { action: 'redo' } });
    store.redoTraceEdit();
    setToolbarStatus(null);
  };

  return (
    <section className="rvc-center-toolbar" aria-label={t("Barre d'outils centrale")}>
      <div ref={viewportRef} className="rvc-center-toolbar__viewport">
        <div className="rvc-center-toolbar__track" role="toolbar" aria-label={t("Outils d'édition du parcours")}>
          {/*
           * Center panel toggle — mirrors the map-side panel toggles:
           * engaged (shown) = 60% black fill, hidden = red.
           */}
          {onTogglePanel ? (
            <>
              <button
                type="button"
                className={`rvc-center-toolbar__button rvc-center-toolbar__button--panel-toggle${
                  isPanelVisible ? ' is-panel-shown' : ' is-panel-hidden'
                }`}
                aria-label={isPanelVisible ? t('Masquer le panneau central') : t('Afficher le panneau central')}
                aria-pressed={isPanelVisible}
                title={isPanelVisible ? t('Masquer le panneau central') : t('Afficher le panneau central')}
                onClick={onTogglePanel}
              >
                <SvgV2Icon name="line-chart-up-01.svg" size={16} />
              </button>

              <div className="rvc-center-toolbar__separator" aria-hidden="true" />
            </>
          ) : null}

          <ToolbarIconButton label="Annuler la modification" onClick={handleUndoTraceEdit} disabled={!canUndoTraceEdit}>
            <IconUndo />
          </ToolbarIconButton>

          <ToolbarIconButton label="Rétablir" onClick={handleRedoTraceEdit} disabled={!canRedoTraceEdit}>
            <IconRedo />
          </ToolbarIconButton>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Sélection">
            <IconCursor size={18} />
          </ToolbarIconButton>

          <button
            className={placementArmed
              ? 'rvc-center-toolbar__button rvc-center-toolbar__button--accent rvc-center-toolbar__button--accent-armed'
              : 'rvc-center-toolbar__button rvc-center-toolbar__button--accent'}
            type="button"
            aria-label={t('Ajouter')}
            title={addButtonTitle}
            onClick={handleAddButtonClick}
            disabled={!canPlaceOnChart}
            aria-haspopup="menu"
            aria-expanded={addMenuAnchor != null}
            aria-pressed={placementArmed}
          >
            <IconPlusCircle />
            <span className="rvc-center-toolbar__button-text">{t('Ajouter')}</span>
            <IconChevronDown size={16} />
          </button>

          <TimelineKindMenu
            anchorEl={addMenuAnchor}
            open={addMenuAnchor != null && canPlaceOnChart}
            options={TIMELINE_ADD_MENU_OPTIONS}
            onClose={() => setAddMenuAnchor(null)}
            onSelect={handleSelectAddKind}
          />

          <button
            className={traceArmed
              ? 'rvc-center-toolbar__button rvc-center-toolbar__button--label rvc-center-toolbar__button--active'
              : 'rvc-center-toolbar__button rvc-center-toolbar__button--label'}
            type="button"
            aria-label="Tracer"
            title={traceToolTitle}
            onClick={handleToggleTrace}
            disabled={!canTrace}
            aria-pressed={traceArmed}
          >
            <IconPencilLine />
            <span className="rvc-center-toolbar__button-text">Tracer</span>
          </button>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Inverser" onClick={handleReverseTrace} disabled={!canReverseTrace}>
            <IconSwitchHorizontal />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Découper"
            onClick={handleToggleRouteSplit}
            disabled={!canSplitTrace}
            active={splitArmed}
          >
            <IconScissors />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Interdire"
            onClick={handleToggleForbiddenZone}
            disabled={!canEditForbiddenZone}
            active={forbiddenZoneArmed}
          >
            <IconSlashOctagon />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Supprimer"
            onClick={handleDeleteActiveRoute}
            disabled={!canDeleteActiveRoute}
          >
            <IconTrash />
          </ToolbarIconButton>

          {commentTool ? (
            <>
              <div className="rvc-center-toolbar__separator" aria-hidden="true" />
              <CommentToolbarButton onBeforeArm={handleBeforeArmComment} />
            </>
          ) : null}

          {inlineToolbarStatus ? (
            <div className="rvc-center-toolbar__status-inline" role="status" aria-live="polite">
              {inlineToolbarStatus}
            </div>
          ) : null}

          <div className="rvc-center-toolbar__spacer" aria-hidden="true" />

          <div className="rvc-center-toolbar__playback" aria-label={t('Lecture du parcours')}>
            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label={t('Ralentir le flyover')}
              title={t('Ralentir le flyover')}
              onClick={slowDown}
              disabled={!canPlay || !canSlowDown}
            >
              <IconSkip direction="backward" />
            </button>

            <button
              className={
                isPlaying
                  ? 'rvc-center-toolbar__button rvc-center-toolbar__button--play rvc-center-toolbar__button--play-active'
                  : 'rvc-center-toolbar__button rvc-center-toolbar__button--play'
              }
              type="button"
              aria-label={isPlaying ? t('Mettre en pause le flyover') : t('Lancer le flyover')}
              title={isPlaying ? t('Mettre en pause le flyover') : t('Lancer le flyover')}
              aria-pressed={isPlaying}
              onClick={togglePlayback}
              disabled={!canPlay}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label={t('Accélérer le flyover')}
              title={t('Accélérer le flyover')}
              onClick={speedUp}
              disabled={!canPlay || !canSpeedUp}
            >
              <IconSkip direction="forward" />
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label={t('Revenir au début du flyover')}
              title={t('Revenir au début du flyover')}
              onClick={resetPlayback}
              disabled={!canPlay}
            >
              <IconClockRewind />
            </button>

            <div className="rvc-center-toolbar__metrics" aria-label={t('Résumé de lecture')}>
              <span>{distanceLabel}</span>
              <span>{timeLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});