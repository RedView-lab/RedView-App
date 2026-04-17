import { useCallback, useState } from 'react';
import { ItineraryPanel } from './ItineraryPanel';
import {
  createDefaultItinerary,
  createDefaultProject,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import type {
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  TimelineView,
} from './types';

interface ItineraryPanelContainerProps {
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  onClose?: () => void;
}

/**
 * Front-end only container. All handlers operate on in-memory project state.
 * Wire real persistence (Supabase, undo stack, routing engine) later.
 */
export function ItineraryPanelContainer({
  width,
  onResizeStart,
  isResizing,
  onClose,
}: ItineraryPanelContainerProps) {
  const [project, setProject] = useState<ItineraryProject>(() =>
    createDefaultProject(),
  );

  const updateActive = useCallback(
    (mut: (it: ItineraryProject['itineraries'][number]) => void) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== prev.activeItineraryId) return it;
          const copy = structuredClone(it);
          mut(copy);
          return copy;
        }),
      }));
    },
    [],
  );

  return (
    <ItineraryPanel
      project={project}
      profiles={DEFAULT_PROFILES}
      width={width}
      isResizing={isResizing}
      onResizeStart={onResizeStart}
      onClose={onClose}
      onSaveProject={() => {
        setProject((p) => ({
          ...p,
          savedAt: new Date().toISOString(),
          sizeBytes: p.sizeBytes ?? 4096,
        }));
      }}
      onDownloadProject={() => {}}
      onShareProject={() => {}}
      onRenameProject={(next) => setProject((p) => ({ ...p, name: next }))}
      onSelectItinerary={(id) =>
        setProject((p) => ({ ...p, activeItineraryId: id }))
      }
      onAddItinerary={() =>
        setProject((p) => {
          const idx = p.itineraries.length;
          const color =
            ITINERARY_COLORS[idx % ITINERARY_COLORS.length] ?? ITINERARY_COLORS[0];
          const next = createDefaultItinerary(idx + 1, color);
          return {
            ...p,
            itineraries: [...p.itineraries, next],
            activeItineraryId: next.id,
          };
        })
      }
      onChangeMode={(mode: PanelMode) =>
        setProject((p) => ({ ...p, activeMode: mode }))
      }
      onChangeProfile={(id) =>
        updateActive((it) => {
          it.profileId = id;
        })
      }
      onUndo={() => {}}
      onRedo={() => {}}
      canUndo={false}
      canRedo={false}
      onSaveProfile={() => {}}
      onChangePriority={(key: keyof PrioritiesState, value) =>
        updateActive((it) => {
          it.priorities[key] = value;
        })
      }
      onChangeRoadType={(key, value) =>
        updateActive((it) => {
          (it.roadTypes[key] as RoadTypesState[typeof key]) = value;
        })
      }
      onChangeRhythm={(key, value) =>
        updateActive((it) => {
          (it.rhythm[key] as RhythmState[typeof key]) = value;
        })
      }
      onUploadFit={() => {}}
      onCalculate={() => {}}
      onChangePoiEntry={(category, next) =>
        updateActive((it) => {
          it.poi[category] = next;
        })
      }
      onChangePoiRefine={(value) =>
        updateActive((it) => {
          it.poi.refineResults = value;
        })
      }
      onOpenPoiCategories={() => {}}
      onLoadPois={() => {}}
      onChangeTimelineView={(view: TimelineView) =>
        setProject((p) => ({ ...p, timelineView: view }))
      }
      onAddTimelineItem={() =>
        updateActive((it) => {
          const newId = `wp-${Date.now()}`;
          const endIdx = it.timeline.findIndex((i) => i.kind === 'end');
          const insertAt = endIdx >= 0 ? endIdx : it.timeline.length;
          it.timeline.splice(insertAt, 0, {
            id: newId,
            kind: 'waypoint',
            label: 'Nouveau point',
            distanceKm: null,
          });
        })
      }
      onToggleTimelineItem={(id, visible) =>
        updateActive((it) => {
          const row = it.timeline.find((i) => i.id === id);
          if (row) row.visible = visible;
        })
      }
      onRemoveTimelineItem={(id) =>
        updateActive((it) => {
          it.timeline = it.timeline.filter(
            (i) => i.id !== id || i.kind === 'start' || i.kind === 'end',
          );
        })
      }
      onFavoriteTimelineItem={(id, favorite) =>
        updateActive((it) => {
          const row = it.timeline.find((i) => i.id === id);
          if (row) row.favorite = favorite;
        })
      }
      onSearchTimeline={() => {}}
      onOpenTimelineSettings={() => {}}
    />
  );
}
