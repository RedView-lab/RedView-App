import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { formatCoordinates, requestMapPoiDraft } from '@/features/map3d';
import {
  useProjectStoreOptional,
  type TimelineAddItemKind,
} from '@/features/itineraryPanel';
import { dispatchItineraryMapAction } from '@/features/itineraryPanel/lib/mapActionBridge';
import { reverseGeocodeSettlement } from '@/features/itineraryPanel/lib/geocoding';
import { translateAppText } from '@/shared/i18n';
import { useEscapeToExit } from '@/shared/hooks/useEscapeToExit';
import {
  ChartPlacementToolContext,
  type ChartPlacementTarget,
  type ChartPlacementToolContextValue,
} from './useChartPlacementTool';

/** Confirmation affichée dans la barre d'outils après une pose, puis effacée. */
const DONE_MESSAGE_MS = 4_000;

/** Mêmes noms que le menu « + » de la feuille de route. */
const KIND_LABELS: Record<TimelineAddItemKind, string> = {
  step: 'Étape',
  waypoint: 'Waypoint',
  poi: 'POI',
  pause: 'Pause',
  start: 'Départ',
  end: 'Destination',
};

const DONE_MESSAGES: Record<TimelineAddItemKind, string> = {
  step: 'Étape ajoutée au km {{km}}',
  waypoint: 'Point de passage ajouté au km {{km}}',
  poi: 'POI au km {{km}} : choisissez sa catégorie sur la carte',
  pause: 'Pause ajoutée au km {{km}}',
  start: 'Départ placé au km {{km}}',
  end: 'Destination placée au km {{km}}',
};

function initialRowLabel(kind: Exclude<TimelineAddItemKind, 'poi'>, target: ChartPlacementTarget): string {
  if (kind === 'pause') return translateAppText('Pause');
  if (kind === 'step') return translateAppText('Étape');
  if (kind === 'waypoint') return translateAppText('Nouveau point');
  // Départ / arrivée : comme « Démarrer ici » sur la carte sans lieu nommé.
  return formatCoordinates(target.lat, target.lon);
}

/**
 * « Ajouter » de la barre d'outils centrale : l'utilisateur choisit un type
 * (même menu que le « + » de la feuille de route), puis clique sur le graphique
 * d'analyse là où il va. Étapes, pauses et extrémités sont appliquées par le
 * panneau d'itinéraire (pont d'actions de la carte, qui sélectionne aussi la
 * nouvelle ligne) ; un POI ouvre la carte de brouillon de la carte.
 */
export function ChartPlacementToolProvider({ children }: { children: ReactNode }) {
  const store = useProjectStoreOptional();
  const [armedKindState, setArmedKind] = useState<TimelineAddItemKind | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState(false);

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  ) ?? null;
  const activeItineraryId = activeItinerary?.id ?? null;
  const canPlace = (activeItinerary?.gpxRoute?.points.length ?? 0) >= 2;
  const armedKind = canPlace ? armedKindState : null;

  // Un autre itinéraire sélectionné : la pose en attente visait le précédent.
  const [trackedItineraryId, setTrackedItineraryId] = useState(activeItineraryId);
  if (trackedItineraryId !== activeItineraryId) {
    setTrackedItineraryId(activeItineraryId);
    setArmedKind(null);
    setStatusMessage(null);
  }

  const deactivate = useCallback(() => {
    setArmedKind(null);
    setStatusMessage(null);
  }, []);

  const arm = useCallback((kind: TimelineAddItemKind) => {
    if (!canPlace) return;
    setArmedKind(kind);
    setDoneMessage(false);
    setStatusMessage(translateAppText('Cliquez sur le graphique pour placer : {{kind}}', {
      kind: translateAppText(KIND_LABELS[kind]),
    }));
  }, [canPlace]);

  const rejectOutsideRoute = useCallback(() => {
    setStatusMessage(translateAppText('Cliquez sur le profil de l’itinéraire actif'));
  }, []);

  const placeAt = useCallback((target: ChartPlacementTarget) => {
    if (!armedKind || !activeItineraryId) return;
    const km = (target.distanceM / 1_000).toFixed(1);

    if (armedKind === 'poi') {
      requestMapPoiDraft({ lat: target.lat, lon: target.lon });
    } else {
      const label = initialRowLabel(armedKind, target);
      dispatchItineraryMapAction({
        kind: 'route-point-add',
        payload: {
          itineraryId: activeItineraryId,
          kind: armedKind,
          lat: target.lat,
          lon: target.lon,
          distanceM: target.distanceM,
          label,
        },
      });

      // Nom de lieu de l'étape / du départ / de l'arrivée, résolu en arrière-plan.
      if (armedKind !== 'pause' && store) {
        const itineraryId = activeItineraryId;
        void reverseGeocodeSettlement(target.lon, target.lat, { maxDistanceMeters: 1000 })
          .then((settlement) => {
            const name = settlement?.name?.trim();
            if (!name) return;
            store.updateItineraryWithoutHistory(itineraryId, (it) => {
              const row = it.timeline.find(
                (item) => item.lat === target.lat && item.lon === target.lon && item.label === label,
              );
              if (row) row.label = name;
            });
          })
          .catch(() => {
            /* garder le libellé initial */
          });
      }
    }

    setArmedKind(null);
    setDoneMessage(true);
    setStatusMessage(translateAppText(DONE_MESSAGES[armedKind], { km }));
  }, [activeItineraryId, armedKind, store]);

  useEffect(() => {
    if (!doneMessage) return;
    const timer = window.setTimeout(() => {
      setDoneMessage(false);
      setStatusMessage(null);
    }, DONE_MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [doneMessage, statusMessage]);

  // Échap annule le placement en attente.
  useEscapeToExit(armedKind != null, deactivate);

  const value = useMemo<ChartPlacementToolContextValue>(
    () => ({
      armedKind,
      canPlace,
      statusMessage: armedKind || doneMessage ? statusMessage : null,
      arm,
      deactivate,
      placeAt,
      rejectOutsideRoute,
    }),
    [arm, armedKind, canPlace, deactivate, doneMessage, placeAt, rejectOutsideRoute, statusMessage],
  );

  return (
    <ChartPlacementToolContext.Provider value={value}>
      {children}
    </ChartPlacementToolContext.Provider>
  );
}
