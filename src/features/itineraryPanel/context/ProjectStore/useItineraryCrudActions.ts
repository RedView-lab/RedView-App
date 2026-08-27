import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  createDefaultItinerary,
  ITINERARY_COLORS,
} from '../../lib/project';
import type {
  Itinerary,
  ItineraryProject,
  RouteRenderMode,
} from '../../types';

interface UseItineraryCrudActionsArgs {
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

/**
 * Gère les actions CRUD de base sur les itinéraires du projet
 * (nom, couleur, visibilité, mode de rendu, opacité, ajout, duplication, suppression).
 */
export function useItineraryCrudActions({ setProject }: UseItineraryCrudActionsArgs) {
  const updateItinerary = useCallback(
    (
      id: string,
      mut: (draft: ItineraryProject['itineraries'][number]) => void,
    ) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== id) return it;
          const copy = structuredClone(it);
          mut(copy);
          return copy;
        }),
      }));
    },
    [setProject],
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
      updateItinerary(id, (it) => {
        it.visible = visible;
        it.analysisVisible = visible;
      });
    },
    [updateItinerary],
  );

  const setItineraryAnalysisVisibility = useCallback(
    (id: string, visible: boolean) => {
      updateItinerary(id, (it) => {
        it.visible = visible;
        it.analysisVisible = visible;
      });
    },
    [updateItinerary],
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

      setProject((currentProject) => {
        const nextIndex = currentProject.itineraries.length;
        const color =
          ITINERARY_COLORS[nextIndex % ITINERARY_COLORS.length] ?? ITINERARY_COLORS[0];
        const base = createDefaultItinerary(nextIndex + 1, color);
        const next = { ...base, ...overrides };
        createdId = next.id;

        return {
          ...currentProject,
          itineraries: [...currentProject.itineraries, next],
          activeItineraryId: next.id,
        };
      });

      return createdId;
    },
    [setProject],
  );

  const duplicateItinerary = useCallback(
    (id: string) => {
      let resultBox: { createdItineraryId: string; createdItineraryName: string } | null = null;

      setProject((currentProject) => {
        const source = currentProject.itineraries.find((itinerary) => itinerary.id === id);
        if (!source) return currentProject;

        const nextIndex = currentProject.itineraries.length + 1;
        const color =
          ITINERARY_COLORS[currentProject.itineraries.length % ITINERARY_COLORS.length] ??
          ITINERARY_COLORS[0];
        const duplicateNameBase = `${source.name} (copie)`;
        let duplicateName = duplicateNameBase;
        let suffix = 2;
        while (currentProject.itineraries.some((itinerary) => itinerary.name === duplicateName)) {
          duplicateName = `${duplicateNameBase} ${suffix}`;
          suffix += 1;
        }

        const duplicate = structuredClone(source);
        duplicate.id = `it-${Date.now()}-${nextIndex}`;
        duplicate.name = duplicateName;
        duplicate.color = color;
        duplicate.visible = false;
        duplicate.prediction = null;
        delete duplicate.fitUploads;
        delete duplicate.pendingFitRecompute;
        if (duplicate.metrics) delete duplicate.metrics.durationSec;

        resultBox = {
          createdItineraryId: duplicate.id,
          createdItineraryName: duplicate.name,
        };

        return {
          ...currentProject,
          itineraries: [...currentProject.itineraries, duplicate],
          activeItineraryId: duplicate.id,
        };
      });

      return resultBox;
    },
    [setProject],
  );

  const removeItinerary = useCallback(
    (id: string) => {
      let removed = false;

      setProject((currentProject) => {
        const remaining = currentProject.itineraries.filter((itinerary) => itinerary.id !== id);
        if (remaining.length === currentProject.itineraries.length) return currentProject;

        removed = true;
        const nextActive =
          currentProject.activeItineraryId === id
            ? (remaining[0]?.id ?? '')
            : currentProject.activeItineraryId;

        return {
          ...currentProject,
          itineraries: remaining,
          activeItineraryId: nextActive,
        };
      });

      return removed;
    },
    [setProject],
  );

  const clearItineraryRoute = useCallback(
    (id: string) => {
      updateItinerary(id, (it) => {
        const emptyTimeline = createDefaultItinerary(1, it.color).timeline;
        it.timeline = structuredClone(emptyTimeline);
        delete it.gpxRoute;
        delete it.metrics;
        delete it.poiFeatures;
        delete it.routeAudit;
        delete it.pendingTraceExtension;
        delete it.pendingRoutePatch;
        it.prediction = null;
      });
    },
    [updateItinerary],
  );

  return {
    updateItinerary,
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
