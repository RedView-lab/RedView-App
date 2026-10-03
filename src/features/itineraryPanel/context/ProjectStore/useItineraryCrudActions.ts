import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { translateAppText } from '@/shared/i18n';
import {
  createDefaultItinerary,
  ITINERARY_COLORS,
} from '../../lib/project';
import type {
  Itinerary,
  ItineraryProject,
  RouteRenderMode,
} from '../../types';
import type { DuplicateItineraryOverrides } from './types';

interface UseItineraryCrudActionsArgs {
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  /** Écriture hors historique (résultats async). */
  setProjectWithoutHistory: Dispatch<SetStateAction<ItineraryProject>>;
  /**
   * Enregistre une mutation destructive dans l'historique undo/redo.
   * Requis pour que les suppressions d'itinéraires soient annulables.
   */
  commitTraceMutation: (
    itineraryId: string,
    mutate: (draft: ItineraryProject) => boolean | void,
  ) => boolean;
}

/**
 * Gère les actions CRUD de base sur les itinéraires du projet
 * (nom, couleur, visibilité, mode de rendu, opacité, ajout, duplication, suppression).
 */
function applyItineraryMutation(
  prev: ItineraryProject,
  id: string,
  mut: (draft: ItineraryProject['itineraries'][number]) => void,
): ItineraryProject {
  return {
    ...prev,
    itineraries: prev.itineraries.map((it) => {
      if (it.id !== id) return it;
      const copy = structuredClone(it);
      mut(copy);
      return copy;
    }),
  };
}

export function useItineraryCrudActions({
  setProject,
  setProjectWithoutHistory,
  commitTraceMutation,
}: UseItineraryCrudActionsArgs) {
  /** Modification utilisateur d'un itinéraire (enregistrée dans l'historique). */
  const updateItinerary = useCallback(
    (
      id: string,
      mut: (draft: ItineraryProject['itineraries'][number]) => void,
    ) => {
      setProject((prev) => applyItineraryMutation(prev, id, mut));
    },
    [setProject],
  );

  /**
   * Complément async d'une action déjà enregistrée (ex. nom de lieu géocodé
   * d'un point qu'on vient de poser) : hors historique, ne vide pas « Rétablir ».
   */
  const updateItineraryWithoutHistory = useCallback(
    (
      id: string,
      mut: (draft: ItineraryProject['itineraries'][number]) => void,
    ) => {
      setProjectWithoutHistory((prev) => applyItineraryMutation(prev, id, mut));
    },
    [setProjectWithoutHistory],
  );

  const setItineraryName = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      updateItinerary(id, (it) => {
        it.name = trimmed;
      });
    },
    [updateItinerary],
  );

  const setItineraryColor = useCallback(
    (id: string, color: string) => {
      updateItinerary(id, (it) => {
        it.color = color;
      });
    },
    [updateItinerary],
  );

  const setItineraryVisibility = useCallback(
    (id: string, visible: boolean) => {
      setProject((prev) => {
        const nextItineraries = prev.itineraries.map((it) => {
          if (it.id !== id) return it;
          return {
            ...it,
            visible,
            analysisVisible: visible,
          };
        });

        let nextActiveId = prev.activeItineraryId;
        if (!visible && prev.activeItineraryId === id) {
          const visibleCandidate = nextItineraries.find((it) => it.visible !== false && it.id !== id);
          if (visibleCandidate) {
            nextActiveId = visibleCandidate.id;
          }
        } else if (visible && (!prev.activeItineraryId || !nextItineraries.some((it) => it.id === prev.activeItineraryId && it.visible !== false))) {
          nextActiveId = id;
        }

        return {
          ...prev,
          itineraries: nextItineraries,
          activeItineraryId: nextActiveId,
        };
      });
    },
    [setProject],
  );

  const setItineraryAnalysisVisibility = useCallback(
    (id: string, visible: boolean) => {
      setProject((prev) => {
        const nextItineraries = prev.itineraries.map((it) => {
          if (it.id !== id) return it;
          return {
            ...it,
            visible,
            analysisVisible: visible,
          };
        });

        let nextActiveId = prev.activeItineraryId;
        if (!visible && prev.activeItineraryId === id) {
          const visibleCandidate = nextItineraries.find((it) => it.visible !== false && it.id !== id);
          if (visibleCandidate) {
            nextActiveId = visibleCandidate.id;
          }
        } else if (visible && (!prev.activeItineraryId || !nextItineraries.some((it) => it.id === prev.activeItineraryId && it.visible !== false))) {
          nextActiveId = id;
        }

        return {
          ...prev,
          itineraries: nextItineraries,
          activeItineraryId: nextActiveId,
        };
      });
    },
    [setProject],
  );

  const setItineraryRenderMode = useCallback(
    (id: string, mode: RouteRenderMode) => {
      updateItinerary(id, (it) => {
        it.renderMode = mode;
      });
    },
    [updateItinerary],
  );

  const setItineraryOpacity = useCallback(
    (id: string, opacity: number) => {
      updateItinerary(id, (it) => {
        it.opacity = Math.max(0, Math.min(100, Math.round(opacity)));
      });
    },
    [updateItinerary],
  );

  const addItinerary = useCallback(
    (overrides: Partial<Itinerary> = {}) => {
      let createdId: string | null = null;

      // Historisé : l'ajout (dont l'import GPX) est une étape d'undo à part
      // entière, au lieu d'être effacé en silence par l'annulation d'une
      // édition antérieure.
      commitTraceMutation('', (draft) => {
        const nextIndex = draft.itineraries.length;
        const color =
          ITINERARY_COLORS[nextIndex % ITINERARY_COLORS.length] ?? ITINERARY_COLORS[0];
        const base = createDefaultItinerary(nextIndex + 1, color);
        const next = { ...base, ...structuredClone(overrides) };
        createdId = next.id;

        draft.itineraries = [...draft.itineraries, next];
        draft.activeItineraryId = next.id;
      });

      return createdId;
    },
    [commitTraceMutation],
  );

  const duplicateItinerary = useCallback(
    (id: string, overrides: DuplicateItineraryOverrides = {}) => {
      let resultBox: { createdItineraryId: string; createdItineraryName: string } | null = null;

      commitTraceMutation(id, (currentProject) => {
        const source = currentProject.itineraries.find((itinerary) => itinerary.id === id);
        if (!source) return false;
        if (overrides.id && currentProject.itineraries.some((itinerary) => itinerary.id === overrides.id)) {
          return false;
        }

        const nextIndex = currentProject.itineraries.length + 1;
        const color =
          ITINERARY_COLORS[currentProject.itineraries.length % ITINERARY_COLORS.length] ??
          ITINERARY_COLORS[0];
        const duplicateNameBase = translateAppText('{{name}} (copie)', { name: source.name });
        let duplicateName = duplicateNameBase;
        let suffix = 2;
        while (currentProject.itineraries.some((itinerary) => itinerary.name === duplicateName)) {
          duplicateName = `${duplicateNameBase} ${suffix}`;
          suffix += 1;
        }

        const duplicate = structuredClone(source);
        duplicate.id = overrides.id ?? `it-${Date.now()}-${nextIndex}`;
        duplicate.name = overrides.name?.trim() || duplicateName;
        duplicate.color = overrides.color ?? color;
        duplicate.visible = overrides.visible ?? false;
        duplicate.prediction = null;
        delete duplicate.fitUploads;
        delete duplicate.pendingFitRecompute;
        if (duplicate.metrics) delete duplicate.metrics.durationSec;

        resultBox = {
          createdItineraryId: duplicate.id,
          createdItineraryName: duplicate.name,
        };

        currentProject.itineraries = [...currentProject.itineraries, duplicate];
        currentProject.activeItineraryId = duplicate.id;
      });

      return resultBox;
    },
    [commitTraceMutation],
  );

  const removeItinerary = useCallback(
    (id: string) => {
      let removed = false;

      commitTraceMutation(id, (draft) => {
        const remaining = draft.itineraries.filter((itinerary) => itinerary.id !== id);
        if (remaining.length === draft.itineraries.length) return false;

        removed = true;
        draft.itineraries = remaining;
        if (draft.activeItineraryId === id) {
          draft.activeItineraryId = remaining[0]?.id ?? '';
        }
      });

      return removed;
    },
    [commitTraceMutation],
  );

  const clearItineraryRoute = useCallback(
    (id: string) => {
      commitTraceMutation(id, (draft) => {
        const target = draft.itineraries.find((itinerary) => itinerary.id === id);
        if (!target) return false;

        const emptyTimeline = createDefaultItinerary(1, target.color).timeline;
        target.timeline = structuredClone(emptyTimeline);
        delete target.gpxRoute;
        delete target.metrics;
        delete target.poiFeatures;
        delete target.poiSearchSignature;
        delete target.poiRouteSignature;
        delete target.poiAutoSort;
        delete target.routeAudit;
        delete target.pendingTraceExtension;
        delete target.pendingRoutePatch;
        target.prediction = null;
      });
    },
    [commitTraceMutation],
  );

  return {
    updateItinerary,
    updateItineraryWithoutHistory,
    setItineraryName,
    setItineraryColor,
    setItineraryVisibility,
    setItineraryAnalysisVisibility,
    setItineraryRenderMode,
    setItineraryOpacity,
    addItinerary,
    duplicateItinerary,
    removeItinerary,
    clearItineraryRoute,
  };
}
