import { useEffect, useMemo, useState } from 'react';
import { Slider } from '@/features/controlPanel/components/Slider';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { useRouteMergeToolOptional } from '../../routeMerge';
import { useRouteSplitToolOptional } from '../../routeSplit';
import { useTraceToolOptional } from '../../tracer';
import { useForbiddenZoneToolOptional } from '../../forbiddenZones';
import { cleanGpxGlitches } from '@/features/itineraryPanel/lib/routes';
import { routeLengthM } from '@/features/poi/lib/gpx-loader';
import { IconChevronDown } from '../CenterPanelIcons';
import { useAnalysisFlyover } from '../../flyover';
import {
  IconClockRewind,
  IconCursor,
  IconPause,
  IconPencilLine,
  IconPlay,
  IconPlusCircle,
  IconBezier,
  IconRedo,
  IconReflectVertical,
  IconScissors,
  IconSkip,
  IconSlashOctagon,
  IconSwitchHorizontal,
  IconTrash,
  IconUndo,
  IconWrench,
} from './icons';
import { ToolbarIconButton } from './ToolbarIconButton';
import {
  BALANCED_POINTS_PER_KM,
  clamp,
  computeDefaultPointsPerKm,
  routePointsEqual,
} from './utils';

export function CenterPanelToolbar() {
  const store = useProjectStoreOptional();
  const routeMergeTool = useRouteMergeToolOptional();
  const routeSplitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [activeSubtool, setActiveSubtool] = useState<'simplify' | null>(null);
  const [simplifyPointsPerKm, setSimplifyPointsPerKm] = useState(BALANCED_POINTS_PER_KM);
  const [toolbarStatus, setToolbarStatus] = useState<string | null>(null);
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
  const canDeleteActiveRoute = Boolean(
    activeItinerary && (
      (activeItinerary.gpxRoute?.points.length ?? 0) > 0 ||
      activeItinerary.timeline.some((item) =>
        item.kind === 'waypoint' ||
        item.kind === 'pause' ||
        item.kind === 'poi' ||
        item.lat != null ||
        item.lon != null ||
        (item.kind === 'start' && item.label !== 'Rechercher un lieu') ||
        (item.kind === 'end' && item.label !== 'Rechercher un lieu'),
      ) ||
      activeItinerary.metrics ||
      activeItinerary.poiFeatures?.length ||
      activeItinerary.prediction
    ),
  );
  const handleDeleteActiveRoute = () => {
    if (!store || !activeItinerary) return;
    store.clearItineraryRoute(activeItinerary.id);
    setToolbarStatus('Trace supprimée');
  };
  const handleAddItinerary = () => {
    if (!store) return;
    store.addItinerary();
    setToolbarStatus('Nouvel itinéraire créé');
  };
  const simplifiableRoute =
    activeItinerary?.gpxRoute && activeItinerary.gpxRoute.source !== 'brouter'
      ? activeItinerary.gpxRoute
      : null;
  const reversibleRoute = activeItinerary?.gpxRoute ?? null;
  const activeTracePointCount = simplifiableRoute?.points.length ?? 0;
  const reversibleTracePointCount = reversibleRoute?.points.length ?? 0;
  const activeTraceDistanceKm = useMemo(() => {
    if (!simplifiableRoute) return 0;
    return routeLengthM(simplifiableRoute.points) / 1000;
  }, [simplifiableRoute]);
  const currentPointsPerKm = useMemo(() => {
    if (activeTracePointCount <= 0 || activeTraceDistanceKm <= 0) return 0;
    return activeTracePointCount / activeTraceDistanceKm;
  }, [activeTraceDistanceKm, activeTracePointCount]);
  const canSimplifyTrace = activeTracePointCount > 2;
  const canCleanTrace = activeTracePointCount > 2;
  const canReverseTrace = reversibleTracePointCount > 1;
  const canAuditTrace = activeItinerary?.gpxRoute?.source === 'brouter';
  const canMergeTrace = routeMergeTool?.canMerge ?? false;
  const mergeStatusMessage = routeMergeTool?.statusMessage ?? null;
  const mergeArmed = routeMergeTool?.armed ?? false;
  const mergeLoading = routeMergeTool?.isMerging ?? false;
  const canSplitTrace = routeSplitTool?.canSplit ?? false;
  const splitStatusMessage = routeSplitTool?.statusMessage ?? null;
  const splitArmed = routeSplitTool?.armed ?? false;
  const canTrace = traceTool?.canTrace ?? false;
  const traceStatusMessage = traceTool?.statusMessage ?? null;
  const traceArmed = traceTool?.armed ?? false;
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
  const auditFindings = activeItinerary?.routeAudit?.findings ?? [];
  const auditVisible = activeItinerary?.routeAudit?.visible === true;
  const simplifyTargetPoints = useMemo(
    () =>
      clamp(
        Math.round(Math.max(activeTraceDistanceKm, 0.25) * simplifyPointsPerKm),
        2,
        Math.max(2, activeTracePointCount),
      ),
    [activeTraceDistanceKm, activeTracePointCount, simplifyPointsPerKm],
  );
  const canApplySimplification = canSimplifyTrace && simplifyTargetPoints < activeTracePointCount;
  const inlineToolbarStatus = useMemo(() => {
    if (mergeStatusMessage) return mergeStatusMessage;
    if (splitStatusMessage) return splitStatusMessage;
    if (forbiddenZoneStatusMessage) return forbiddenZoneStatusMessage;
    if (traceStatusMessage) return traceStatusMessage;
    if (toolbarStatus) return toolbarStatus;
    if (!toolsExpanded) return null;
    if (activeSubtool === 'simplify' && canSimplifyTrace) {
      const reduciblePoints = Math.max(0, activeTracePointCount - simplifyTargetPoints);
      return reduciblePoints > 0
        ? `Réduction possible: ${reduciblePoints.toLocaleString('fr-FR')} point${reduciblePoints > 1 ? 's' : ''} en moins`
        : 'Trace déjà assez légère';
    }
    if (canAuditTrace) {
      return auditFindings.length > 0
        ? `${auditFindings.length} passage${auditFindings.length > 1 ? 's' : ''} trop raide${auditFindings.length > 1 ? 's' : ''} détecté${auditFindings.length > 1 ? 's' : ''}`
        : 'Aucun passage trop raide détecté';
    }
    if (canCleanTrace) {
      return 'Nettoyage de trace disponible';
    }
    return null;
  }, [
    activeSubtool,
    activeTracePointCount,
    auditFindings.length,
    canAuditTrace,
    canCleanTrace,
    forbiddenZoneStatusMessage,
    canSimplifyTrace,
    mergeStatusMessage,
    simplifyTargetPoints,
    splitStatusMessage,
    traceStatusMessage,
    toolbarStatus,
    toolsExpanded,
  ]);

  useEffect(() => {
    setSimplifyPointsPerKm(computeDefaultPointsPerKm(currentPointsPerKm));
  }, [activeItinerary?.id, currentPointsPerKm]);

  useEffect(() => {
    if (!toolsExpanded) {
      setActiveSubtool(null);
    }
  }, [toolsExpanded]);


  useEffect(() => {
    setToolbarStatus(null);
  }, [activeItinerary?.id]);

  const handleToggleTools = () => {
    setToolsExpanded((open) => !open);
  };

  const handleToggleSimplifyTool = () => {
    if (!canSimplifyTrace) return;
    if (!toolsExpanded) {
      setToolsExpanded(true);
      setActiveSubtool('simplify');
      return;
    }
    setActiveSubtool((current) => (current === 'simplify' ? null : 'simplify'));
  };

  const handleApplySimplification = () => {
    if (!store || !activeItinerary || !canApplySimplification) return;
    store.simplifyItineraryGpx(activeItinerary.id, simplifyPointsPerKm);
    setToolbarStatus(`Trace réduite à ${simplifyPointsPerKm.toLocaleString('fr-FR')} pts/km`);
  };

  const handleCleanTrace = () => {
    if (!store || !activeItinerary || !canCleanTrace || !simplifiableRoute) return;
    const cleanedPoints = cleanGpxGlitches(simplifiableRoute.points);
    if (routePointsEqual(cleanedPoints, simplifiableRoute.points)) {
      setToolbarStatus('Aucune aberration détectée');
      return;
    }
    store.cleanItineraryGpxGlitches(activeItinerary.id);
    setToolbarStatus('Trace nettoyée');
  };

  const handleReverseTrace = () => {
    if (!store || !activeItinerary || !canReverseTrace) return;
    const reversed = store.reverseItineraryGpx(activeItinerary.id);
    setToolbarStatus(reversed ? 'Sens du GPX inversé' : 'Inversion indisponible pour cette trace');
  };

  const handleToggleRouteAudit = () => {
    if (!store || !activeItinerary || !canAuditTrace) return;
    if (!activeItinerary.routeAudit) {
      setToolbarStatus('Audit indisponible pour cette trace');
      return;
    }
    if (auditFindings.length === 0) {
      store.updateItinerary(activeItinerary.id, (it) => {
        if (it.routeAudit) it.routeAudit.visible = false;
      });
      setToolbarStatus('Aucune galère détectée');
      return;
    }
    const nextVisible = !auditVisible;
    store.updateItinerary(activeItinerary.id, (it) => {
      if (!it.routeAudit) {
        it.routeAudit = { visible: nextVisible, findings: [] };
        return;
      }
      it.routeAudit.visible = nextVisible;
    });
    setToolbarStatus(
      nextVisible
        ? `${auditFindings.length} portion${auditFindings.length > 1 ? 's' : ''} à vérifier`
        : 'Audit masqué',
    );
  };

  const handleToggleRouteSplit = () => {
    if (!splitArmed) {
      routeMergeTool?.deactivate();
      traceTool?.deactivate();
      forbiddenZoneTool?.deactivate();
    }
    routeSplitTool?.toggle();
    setToolbarStatus(null);
  };

  const handleToggleTrace = () => {
    if (!traceArmed) {
      routeMergeTool?.deactivate();
      routeSplitTool?.deactivate();
      forbiddenZoneTool?.deactivate();
    }
    traceTool?.toggle();
    setToolbarStatus(null);
  };

  const handleToggleForbiddenZone = () => {
    if (!forbiddenZoneArmed) {
      routeMergeTool?.deactivate();
      routeSplitTool?.deactivate();
      traceTool?.deactivate();
    }
    forbiddenZoneTool?.toggle();
    setToolbarStatus(null);
  };

  const handleToggleRouteMerge = () => {
    if (!mergeArmed) {
      routeSplitTool?.deactivate();
      traceTool?.deactivate();
      forbiddenZoneTool?.deactivate();
    }
    routeMergeTool?.toggle();
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
    store.redoTraceEdit();
    setToolbarStatus(null);
  };

  return (
    <section className="rvc-center-toolbar" aria-label="Barre d'outils centrale">
      <div className="rvc-center-toolbar__viewport">
        <div className="rvc-center-toolbar__track" role="toolbar" aria-label="Outils d'édition du parcours">
          <ToolbarIconButton label="Annuler" onClick={handleUndoTraceEdit} disabled={!canUndoTraceEdit}>
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
            className="rvc-center-toolbar__button rvc-center-toolbar__button--accent"
            type="button"
            aria-label="Ajouter"
            title="Ajouter"
            onClick={handleAddItinerary}
            disabled={!store}
          >
            <IconPlusCircle />
            <span className="rvc-center-toolbar__button-text">Ajouter</span>
            <IconChevronDown size={16} />
          </button>

          <button
            className={traceArmed
              ? 'rvc-center-toolbar__button rvc-center-toolbar__button--label rvc-center-toolbar__button--active'
              : 'rvc-center-toolbar__button rvc-center-toolbar__button--label'}
            type="button"
            aria-label="Tracer"
            title="Tracer"
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
            label="Fusion"
            onClick={handleToggleRouteMerge}
            disabled={!canMergeTrace || mergeLoading}
            active={mergeArmed}
          >
            <IconReflectVertical />
          </ToolbarIconButton>

          <ToolbarIconButton label="Courbe de Bézier">
            <IconBezier />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Interdire"
            onClick={handleToggleForbiddenZone}
            disabled={!canEditForbiddenZone}
            active={forbiddenZoneArmed}
          >
            <IconSlashOctagon />
          </ToolbarIconButton>

          <ToolbarIconButton label="Outils" onClick={handleToggleTools} active={toolsExpanded}>
            <IconWrench />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Supprimer"
            onClick={handleDeleteActiveRoute}
            disabled={!canDeleteActiveRoute}
          >
            <IconTrash />
          </ToolbarIconButton>

          {toolsExpanded ? (
            <>
              <ToolbarIconButton
                label="Simplification intelligente de la trace"
                onClick={handleToggleSimplifyTool}
                disabled={!canSimplifyTrace}
                active={activeSubtool === 'simplify'}
              >
                <span className="rvc-center-toolbar__tool-glyph" aria-hidden="true">X</span>
              </ToolbarIconButton>

              <ToolbarIconButton
                label="Nettoyer la trace"
                onClick={handleCleanTrace}
                disabled={!canCleanTrace}
              >
                <span className="rvc-center-toolbar__tool-glyph" aria-hidden="true">X</span>
              </ToolbarIconButton>

              <ToolbarIconButton
                label="Audit de roulabilité"
                onClick={handleToggleRouteAudit}
                disabled={!canAuditTrace}
                active={auditVisible}
              >
                <span className="rvc-center-toolbar__tool-glyph" aria-hidden="true">X</span>
              </ToolbarIconButton>
            </>
          ) : null}

          {inlineToolbarStatus ? (
            <div className="rvc-center-toolbar__status-inline" role="status" aria-live="polite">
              {inlineToolbarStatus}
            </div>
          ) : null}

          <div className="rvc-center-toolbar__spacer" aria-hidden="true" />

          <div className="rvc-center-toolbar__playback" aria-label="Lecture du parcours">
            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Ralentir le flyover"
              title="Ralentir le flyover"
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
              aria-label={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              title={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              aria-pressed={isPlaying}
              onClick={togglePlayback}
              disabled={!canPlay}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Accélérer le flyover"
              title="Accélérer le flyover"
              onClick={speedUp}
              disabled={!canPlay || !canSpeedUp}
            >
              <IconSkip direction="forward" />
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Revenir au début du flyover"
              title="Revenir au début du flyover"
              onClick={resetPlayback}
              disabled={!canPlay}
            >
              <IconClockRewind />
            </button>

            <div className="rvc-center-toolbar__metrics" aria-label="Résumé de lecture">
              <span>{distanceLabel}</span>
              <span>{timeLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {toolsExpanded && activeSubtool === 'simplify' ? (
        <div className="rvc-center-toolbar__tool-panel" role="group" aria-label="Réduction de points GPX">
          <div className="rvc-center-toolbar__tool-panel-head">
            <span className="rvc-center-toolbar__tool-title">Simplification intelligente</span>
            <span className="rvc-center-toolbar__tool-stats">
              {simplifyTargetPoints.toLocaleString('fr-FR')} / {activeTracePointCount.toLocaleString('fr-FR')} pts
            </span>
          </div>

          <div className="rvc-center-toolbar__tool-hint">
            <span>Detaillé courant: {Math.round(currentPointsPerKm).toLocaleString('fr-FR')} pts/km</span>
            <span>Repères utiles: détaillé 40-80 pts/km, léger 15-30 pts/km</span>
          </div>

          <div className="rvc-center-toolbar__tool-panel-row">
            <span className="rvc-center-toolbar__tool-caption">Densité cible</span>
            <div className="rvc-center-toolbar__tool-slider-shell">
              <Slider
                value={simplifyPointsPerKm}
                min={5}
                max={120}
                step={1}
                width="100%"
                onChange={setSimplifyPointsPerKm}
                onCommit={setSimplifyPointsPerKm}
              />
            </div>
            <span className="rvc-center-toolbar__tool-value">{simplifyPointsPerKm} pts/km</span>
          </div>

          <div className="rvc-center-toolbar__tool-panel-actions">
            <span className="rvc-center-toolbar__tool-caption">
              {activeTraceDistanceKm > 0
                ? `${activeTraceDistanceKm.toFixed(1).replace('.', ',')} km -> ${simplifyTargetPoints.toLocaleString('fr-FR')} pts`
                : 'Distance indisponible'}
            </span>
            <button
              className="rvc-center-toolbar__button rvc-center-toolbar__button--accent"
              type="button"
              onClick={handleApplySimplification}
              disabled={!canApplySimplification}
            >
              Réduire
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}