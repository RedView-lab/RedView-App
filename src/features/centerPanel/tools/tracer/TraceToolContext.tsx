import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import { queryPoiAtPoint } from '@/features/poi/lib/poi-markers';

import { useProjectStoreOptional } from '@/features/itineraryPanel/context/ProjectStore/hooks';
import {
  formatGpsCoordinateLabel,
  reverseGeocodeSettlement,
} from '@/features/itineraryPanel/lib/geocoding';
import {
  addItineraryVariantInPlace,
  type CreateItineraryVariantResult,
} from '@/features/itineraryPanel/lib/project';
import {
  applyTraceAppend,
  moveTracePointInItinerary,
  resolveTraceAppendKind,
} from '@/features/itineraryPanel/lib/tracer/traceEdits';
import {
  buildPendingRoutePatchForEditedRow,
  hasEditableRoute,
} from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { translateAppText } from '@/shared/i18n';
import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { isVariantModifierPressed } from '@/shared/lib/platform';
import { useEscapeToExit } from '@/shared/hooks/useEscapeToExit';
import { useCommentToolOptional } from '@/features/comments/context/commentTool';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useRouteMergeToolOptional } from '../routeMerge';
import { isWithinTracePointGesture, type TracePointDragCommit } from './useTracePointDrag';
import { MAP_CURSOR_PRIORITY, setMapCursor } from '@/features/map3d/lib/mapCursor';
import {
  handlePointPanelMousedown,
  shouldIgnoreMapClickAfterPanelDismiss,
} from '@/features/map3d/lib/pointPanelDismiss';
import { TraceToolContext, type TraceToolContextValue } from './useTraceTool';

const TRACE_CURSOR = 'url("/icons/ui/edit-04.svg") 3 17, crosshair';

/** Propriétaires des curseurs déclarés par l'outil auprès de l'arbitre (`setMapCursor`). */
const TRACE_TOOL_CURSOR_OWNER = 'trace-tool';
const TRACE_POINT_DRAG_CURSOR_OWNER = 'trace-point-drag';
const TRACE_MAP_PAN_CURSOR_OWNER = 'trace-map-pan';

/**
 * Classe posée sur le conteneur du canvas pendant le mode Tracer : les poignées
 * de tracé y affichent la main « grab » (elles se déplacent au glisser).
 */
const TRACE_EDITING_CLASS = 'rv-trace-editing';

interface TraceToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function TraceToolProvider({ children, map }: TraceToolProviderProps) {
  const store = useProjectStoreOptional();
  const splitTool = useRouteSplitToolOptional();
  const mergeTool = useRouteMergeToolOptional();
  const commentTool = useCommentToolOptional();
  const [armed, setArmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const startRow = activeItinerary?.timeline.find((row) => row.kind === 'start');
  const endRow = activeItinerary?.timeline.find((row) => row.kind === 'end');
  const hasStartPoint = Boolean(startRow && startRow.lat != null && startRow.lon != null);
  const hasEndPoint = Boolean(endRow && endRow.lat != null && endRow.lon != null);
  const canTrace = Boolean(store && activeItinerary && startRow && endRow);

  const buildTracePrompt = useCallback(() => {
    if (!hasStartPoint) return translateAppText('Cliquez sur la carte pour placer le départ');
    if (!hasEndPoint) return translateAppText('Cliquez sur la carte pour placer l’arrivée');
    return translateAppText('Cliquez pour prolonger le tracé, glissez un point pour le déplacer');
  }, [hasEndPoint, hasStartPoint]);

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
  }, []);

  const hydratePointLabel = useCallback(
    async (
      itineraryId: string,
      kind: 'start' | 'end',
      lon: number,
      lat: number,
      fallbackLabel: string,
    ) => {
      try {
        const settlement = await reverseGeocodeSettlement(lon, lat, {
          maxDistanceMeters: 1000,
        });
        const resolvedLabel = settlement?.name?.trim() || fallbackLabel;
        store?.updateItineraryWithoutHistory(itineraryId, (itinerary) => {
          const currentRow = itinerary.timeline.find((row) => row.kind === kind);
          if (!currentRow || currentRow.lon !== lon || currentRow.lat !== lat) return;
          currentRow.label = resolvedLabel;
        });
      } catch {
        // Keep the GPS fallback label.
      }
    },
    [store],
  );

  const appendPointAt = useCallback(
    (lon: number, lat: number, options?: { asVariant?: boolean }) => {
      if (!store || !activeItinerary) return false;

      const fallbackLabel = formatGpsCoordinateLabel(lon, lat);
      const pointKind = resolveTraceAppendKind(activeItinerary);
      if (!pointKind) return false;

      if (!options?.asVariant) {
        const appended = store.appendTracePoint(activeItinerary.id, {
          lat,
          lon,
          label: fallbackLabel,
        });
        if (!appended) return false;

        setStatusMessage(
          pointKind === 'start'
            ? translateAppText('Départ ajouté. Cliquez pour placer l’arrivée')
            : pointKind === 'end'
              ? translateAppText('Arrivée ajoutée. Cliquez pour prolonger le tracé')
              : translateAppText('Point ajouté, recalcul du tracé en cours'),
        );
        if (pointKind !== 'waypoint') {
          void hydratePointLabel(activeItinerary.id, pointKind, lon, lat, fallbackLabel);
        }
        return true;
      }

      // Alt/Option : on ne touche pas au tracé courant. On le duplique en
      // variante et on n'applique le nouveau point qu'à la copie, qui devient
      // l'itinéraire actif — le mode Tracer reste armé pour continuer dessus.
      const variantBox: { current: CreateItineraryVariantResult | null } = { current: null };
      const recorded = store.commitTraceMutation(activeItinerary.id, (draft) => {
        const created = addItineraryVariantInPlace(draft, activeItinerary.id);
        if (!created) return false;

        const variant = draft.itineraries.find((it) => it.id === created.createdItineraryId);
        if (!variant) return false;
        if (applyTraceAppend(variant, { lat, lon, label: fallbackLabel }) == null) return false;

        variantBox.current = created;
        return true;
      });

      const createdVariant = variantBox.current;
      if (!recorded || !createdVariant) return false;

      setStatusMessage(
        translateAppText('Variante « {{name}} » créée. Le tracé continue dessus.', {
          name: createdVariant.createdItineraryName,
        }),
      );
      if (pointKind !== 'waypoint') {
        void hydratePointLabel(
          createdVariant.createdItineraryId,
          pointKind,
          lon,
          lat,
          fallbackLabel,
        );
      }
      return true;
    },
    [activeItinerary, hydratePointLabel, store],
  );

  /**
   * Relâchement d'un point de passage déplacé. Sans modificateur on édite le
   * tracé courant ; avec Alt/Option on crée une variante et c'est elle qui
   * reçoit le déplacement.
   */
  const armedRef = useRef(armed);
  useEffect(() => {
    armedRef.current = armed;
  });

  const commitTracePointDrag = useCallback(
    (commit: TracePointDragCommit): boolean => {
      if (!store) return false;
      const { target, lon, lat, variant } = commit;

      const variantBox: { current: CreateItineraryVariantResult | null } = { current: null };
      const recorded = store.commitTraceMutation(target.itineraryId, (draft) => {
        let targetItinerary = draft.itineraries.find((it) => it.id === target.itineraryId);
        if (!targetItinerary) return false;

        if (variant) {
          const created = addItineraryVariantInPlace(draft, target.itineraryId);
          if (!created) return false;

          const forked = draft.itineraries.find((it) => it.id === created.createdItineraryId);
          if (!forked) return false;

          variantBox.current = created;
          targetItinerary = forked;
        }

        if (!moveTracePointInItinerary(targetItinerary, target.rowId, lon, lat)) return false;

        if (hasEditableRoute(targetItinerary)) {
          targetItinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(
            targetItinerary,
            target.rowId,
          );
        }
        // L'itinéraire dont on déplace un point devient le sélectionné : il
        // passe au-dessus des autres et son panneau s'affiche.
        draft.activeItineraryId = targetItinerary.id;
        return true;
      });

      if (!recorded) return false;

      const createdVariant = variantBox.current;
      // Hors outil Tracer, aucun message d'outil n'est affiché.
      if (!armedRef.current) return true;
      setStatusMessage(
        createdVariant
          ? translateAppText('Point déplacé dans la variante « {{name}} ».', {
              name: createdVariant.createdItineraryName,
            })
          : translateAppText('Point déplacé, recalcul du tracé en cours'),
      );
      return true;
    },
    [store],
  );

  const handleDraggingChange = useCallback(
    (dragging: boolean) => {
      if (!map) return;
      setMapCursor(
        map,
        TRACE_POINT_DRAG_CURSOR_OWNER,
        dragging ? 'grabbing' : null,
        MAP_CURSOR_PRIORITY.gesture,
      );
    },
    [map],
  );

  const toggle = useCallback(() => {
    if (!canTrace) return;
    setArmed((current) => {
      const next = !current;
      setStatusMessage(next ? buildTracePrompt() : null);
      return next;
    });
  }, [buildTracePrompt, canTrace]);

  /**
   * Arme l'outil, sans le garde `canTrace` de `toggle`.
   *
   * Reproduit l'exclusion mutuelle faite par la toolbar (`handleToggleTrace`) :
   * Découper / Fusionner / Commenter ne peuvent pas rester armés en même temps
   * que Tracer, sinon les deux consomment les clics de la carte.
   */
  const activate = useCallback(() => {
    splitTool?.deactivate();
    mergeTool?.deactivate();
    commentTool?.deactivate();
    setArmed(true);
    setStatusMessage(buildTracePrompt());
  }, [buildTracePrompt, commentTool, mergeTool, splitTool]);

  // Ajustements pendant le rendu (pas d'effet qui remet l'état après coup) :
  // plus de tracé possible → l'outil se désarme et le reste ; outil armé →
  // l'invite suit le départ / l'arrivée posés (elle remplace « Départ ajouté »).
  const canTraceChanged = useHasChanged(canTrace);
  const armedChanged = useHasChanged(armed);
  const promptStepChanged = useHasChanged(`${hasStartPoint}|${hasEndPoint}`);
  if (canTraceChanged && !canTrace && armed) setArmed(false);
  if (armed && (armedChanged || promptStepChanged)) setStatusMessage(buildTracePrompt());

  // Refs : l'effet d'écoute ci-dessous ne doit dépendre que de `armed`/`map`,
  // sinon chaque mutation du projet le ré-exécuterait (listeners et curseur
  // retirés puis reposés).
  const appendPointAtRef = useRef(appendPointAt);
  const deactivateRef = useRef(deactivate);
  useEffect(() => {
    appendPointAtRef.current = appendPointAt;
    deactivateRef.current = deactivate;
  });

  // Échap quitte l'outil ; un glisser de point en cours l'annule d'abord (capture).
  useEscapeToExit(armed, deactivate);

  useEffect(() => {
    if (!armed || !map) return;

    const canvas = map.getCanvas();
    const container = map.getCanvasContainer();

    // Crayon en fond ; la main (survol de la trace) et « grabbing » (gestes)
    // se déclarent par-dessus avec une priorité plus haute.
    setMapCursor(map, TRACE_TOOL_CURSOR_OWNER, TRACE_CURSOR, MAP_CURSOR_PRIORITY.tool);
    container.classList.add(TRACE_EDITING_CLASS);

    // Deux clics rapprochés posent deux points : pas de zoom au double-clic.
    const restoreDoubleClickZoom = map.doubleClickZoom.isEnabled();
    if (restoreDoubleClickZoom) map.doubleClickZoom.disable();

    // Pan de la carte : « grabbing » au lieu du crayon pendant le glisser.
    const handlePanStart = () => {
      setMapCursor(map, TRACE_MAP_PAN_CURSOR_OWNER, 'grabbing', MAP_CURSOR_PRIORITY.gesture);
    };
    const handlePanEnd = () => {
      setMapCursor(map, TRACE_MAP_PAN_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 0) {
        handlePointPanelMousedown(event.target);
      }
    };

    const handleClick = (event: MapMouseEvent) => {
      const originalTarget = event.originalEvent?.target as HTMLElement | null;
      if (
        (originalTarget &&
          originalTarget.closest(
            '.mapboxgl-popup, .rv-poi-draft-card, [data-rv-poi-draft-card], .rv-poi-marker, .rv-checkpoint-marker, [data-rv-comment-pin], [data-rv-comment-card], button, a, [role="button"]',
          )) ||
        isWithinTracePointGesture() ||
        shouldIgnoreMapClickAfterPanelDismiss(originalTarget) ||
        queryPoiAtPoint(map, event.point)
      ) {
        return;
      }

      const asVariant = isVariantModifierPressed(event.originalEvent);
      appendPointAtRef.current(event.lngLat.lng, event.lngLat.lat, { asVariant });
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      deactivateRef.current();
    };

    canvas.addEventListener('mousedown', handleMouseDown, true);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);
    map.on('dragstart', handlePanStart);
    map.on('dragend', handlePanEnd);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown, true);
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      map.off('dragstart', handlePanStart);
      map.off('dragend', handlePanEnd);
      if (restoreDoubleClickZoom) map.doubleClickZoom.enable();
      container.classList.remove(TRACE_EDITING_CLASS);
      setMapCursor(map, TRACE_MAP_PAN_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
      setMapCursor(map, TRACE_POINT_DRAG_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
      setMapCursor(map, TRACE_TOOL_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.tool);
    };
  }, [armed, map]);

  const value = useMemo<TraceToolContextValue>(
    () => ({
      armed,
      canTrace,
      statusMessage,
      toggle,
      activate,
      deactivate,
      commitPointDrag: commitTracePointDrag,
      onPointDraggingChange: handleDraggingChange,
    }),
    [activate, armed, canTrace, commitTracePointDrag, deactivate, handleDraggingChange, statusMessage, toggle],
  );

  return (
    <TraceToolContext.Provider value={value}>
      {children}
    </TraceToolContext.Provider>
  );
}
