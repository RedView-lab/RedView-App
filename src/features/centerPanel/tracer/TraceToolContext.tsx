import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
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
import { buildPendingRoutePatchForEditedRow } from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { translateAppText } from '@/shared/i18n';
import { isVariantModifierPressed } from '@/shared/lib/platform';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useRouteMergeToolOptional } from '../routeMerge';
import { useRouteHoverPreview } from '../hooks/useRouteHoverPreview';
import { useTracePointDrag, type TracePointDragCommit } from './useTracePointDrag';

const TRACE_CURSOR = 'url("/svgv2/icone/edit-04.svg") 3 17, crosshair';
const TRACE_GRABBING_CURSOR = 'grabbing';

interface TraceToolContextValue {
  armed: boolean;
  canTrace: boolean;
  statusMessage: string | null;
  toggle: () => void;
  /**
   * Arme l'outil sans passer par `canTrace`.
   *
   * Utilisé juste après la création d'un itinéraire : dans ce gestionnaire,
   * `canTrace` est encore faux (il se réfère au rendu précédent) mais la mise à
   * jour du store et celle de `armed` sont batchées, donc le rendu suivant voit
   * déjà le nouvel itinéraire. Si l'armement s'avérait impossible, l'effet de
   * désarmement le corrige dans la foulée.
   */
  activate: () => void;
  deactivate: () => void;
}

const TraceToolContext = createContext<TraceToolContextValue | null>(null);

interface TraceToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function TraceToolProvider({ children, map }: TraceToolProviderProps) {
  const store = useProjectStoreOptional();
  const splitTool = useRouteSplitToolOptional();
  const mergeTool = useRouteMergeToolOptional();
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

  /** Vrai pendant qu'une poignée est en cours de déplacement (curseur « grabbing »). */
  const draggingRef = useRef(false);

  // Hover-preview marker: free-follows the cursor (no snap) since every
  // position is a valid click target for start / end / waypoint. During a drag
  // it doubles as the drop-target indicator.
  useRouteHoverPreview({
    map,
    armed,
    color: activeItinerary?.color,
  });

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
        store?.updateItinerary(itineraryId, (itinerary) => {
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
  const commitTracePointDrag = useCallback(
    (commit: TracePointDragCommit) => {
      if (!store) return;
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

        if (targetItinerary.gpxRoute?.source === 'brouter') {
          targetItinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(
            targetItinerary.timeline,
            target.rowId,
          );
        }
        return true;
      });

      if (!recorded) return;

      const createdVariant = variantBox.current;
      setStatusMessage(
        createdVariant
          ? translateAppText('Point déplacé dans la variante « {{name}} ».', {
              name: createdVariant.createdItineraryName,
            })
          : translateAppText('Point déplacé, recalcul du tracé en cours'),
      );
    },
    [store],
  );

  const handleDraggingChange = useCallback(
    (dragging: boolean) => {
      draggingRef.current = dragging;
      const canvas = map?.getCanvas();
      if (canvas) canvas.style.cursor = dragging ? TRACE_GRABBING_CURSOR : TRACE_CURSOR;
    },
    [map],
  );

  useTracePointDrag({
    map,
    armed,
    onCommit: commitTracePointDrag,
    onDraggingChange: handleDraggingChange,
  });

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
   * Découper / Fusionner ne peuvent pas rester armés en même temps que Tracer,
   * sinon les deux consomment les clics de la carte.
   */
  const activate = useCallback(() => {
    splitTool?.deactivate();
    mergeTool?.deactivate();
    setArmed(true);
    setStatusMessage(buildTracePrompt());
  }, [buildTracePrompt, mergeTool, splitTool]);

  useEffect(() => {
    if (canTrace) return;
    setArmed(false);
  }, [canTrace]);

  useEffect(() => {
    if (!armed) return;
    setStatusMessage(buildTracePrompt());
  }, [armed, buildTracePrompt]);

  useEffect(() => {
    if (!armed || !map) return;

    const canvas = map.getCanvas();
    const applyCursor = () => {
      canvas.style.cursor = draggingRef.current ? TRACE_GRABBING_CURSOR : TRACE_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      const asVariant = isVariantModifierPressed(event.originalEvent);
      if (!appendPointAt(event.lngLat.lng, event.lngLat.lat, { asVariant })) return;
      applyCursor();
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      deactivate();
    };

    applyCursor();
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);

    return () => {
      map.off('mousemove', applyCursor);
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      canvas.style.cursor = '';
    };
  }, [appendPointAt, armed, deactivate, map]);

  const value = useMemo<TraceToolContextValue>(
    () => ({
      armed,
      canTrace,
      statusMessage,
      toggle,
      activate,
      deactivate,
    }),
    [activate, armed, canTrace, deactivate, statusMessage, toggle],
  );

  return (
    <TraceToolContext.Provider value={value}>
      {children}
    </TraceToolContext.Provider>
  );
}

export function useTraceToolOptional(): TraceToolContextValue | null {
  return useContext(TraceToolContext);
}
