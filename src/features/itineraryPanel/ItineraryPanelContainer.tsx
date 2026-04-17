import { useCallback, useEffect, useState } from 'react';
import { ItineraryPanel } from './ItineraryPanel';
import { AddItineraryDialog } from './components/AddItineraryDialog';
import { useActiveItinerary } from './ActiveItineraryContext';
import {
  createDefaultItinerary,
  createDefaultProject,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
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
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const ctx = useActiveItinerary();
  // Keep the shared context in sync with our internal project state so other
  // dock panels (PoiPanel) can react to the active itinerary's GPX route.
  useEffect(() => {
    const active =
      project.itineraries.find((i) => i.id === project.activeItineraryId) ??
      null;
    ctx.setActive(active);
    ctx.setItineraries(project.itineraries);
  }, [project, ctx]);

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

  const panel = (
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
      onAddItinerary={() => addItinerary()}
      onOpenAddItinerary={() => setAddDialogOpen(true)}
      onAddItineraryFromGpx={async (file) => {
        const route = await parseGpxFile(file);
        addItinerary({
          name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
          gpxRoute: { name: route.name, points: route.points },
        });
      }}
      onRemoveItinerary={(id) =>
        setProject((p) => {
          if (p.itineraries.length <= 1) return p;
          const remaining = p.itineraries.filter((i) => i.id !== id);
          const nextActive =
            p.activeItineraryId === id ? remaining[0].id : p.activeItineraryId;
          return { ...p, itineraries: remaining, activeItineraryId: nextActive };
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

  function addItinerary(
    overrides: Partial<ReturnType<typeof createDefaultItinerary>> = {},
  ) {
    setProject((p) => {
      const idx = p.itineraries.length;
      const color =
        ITINERARY_COLORS[idx % ITINERARY_COLORS.length] ?? ITINERARY_COLORS[0];
      const base = createDefaultItinerary(idx + 1, color);
      const next = { ...base, ...overrides };
      return {
        ...p,
        itineraries: [...p.itineraries, next],
        activeItineraryId: next.id,
      };
    });
  }

  return (
    <>
      {panel}
      <AddItineraryDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onPickScratch={() => addItinerary()}
        onPickGpx={async (file) => {
          const route = await parseGpxFile(file);
          addItinerary({
            name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
            gpxRoute: { name: route.name, points: route.points },
          });
          // Auto-trigger corridor POI search (the PoiPanel listens via context).
          ctx.triggerCorridorSearch();
        }}
      />
    </>
  );
}
