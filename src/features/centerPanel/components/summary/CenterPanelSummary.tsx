import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import {
  useRef,
  useState,
  useMemo,
  useCallback,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import { useRouteMergeToolOptional } from '@/features/centerPanel/tools/routeMerge';
import { IconMaximize } from '@/features/mapViewportControls/components/MapViewportControlIcons';
import {
  useProjectStoreOptional,
  type Itinerary,
} from '@/features/itineraryPanel';
import {
  buildItineraryVisualNodes,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import { SummaryActionMenu } from './SummaryActionMenu';
import {
  EmptyRow,
  SummaryTreeBranch,
} from './SummaryRow';
import {
  HEADER_CELLS,
  buildSummaryTree,
  findSummaryAncestorIds,
} from './summary-utils';
import type { InlineRenameState } from './types';
import { useCenterActiveSummaryRow } from './useCenterActiveSummaryRow';

interface CenterPanelSummaryProps {
  /** The whole center panel is shown fullscreen (toggle owned by `CenterPanel`). */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function CenterPanelSummary({ fullscreen = false, onToggleFullscreen }: CenterPanelSummaryProps) {
  const { t } = useAppI18n();
  const store = useProjectStoreOptional();
  const routeMergeTool = useRouteMergeToolOptional();
  const itineraries = store?.project.itineraries ?? [];
  const activeItineraryId = store?.project.activeItineraryId ?? null;
  const visualNodes = useMemo(() => buildItineraryVisualNodes(itineraries), [itineraries]);
  const summaryTree = useMemo(() => buildSummaryTree(visualNodes), [visualNodes]);
  const handleToggleAnalysisVisibility =
    store?.setItineraryAnalysisVisibility;
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [editingState, setEditingState] = useState<InlineRenameState | null>(null);
  const [menuState, setMenuState] = useState<{
    itineraryId: string;
    anchorEl: HTMLButtonElement;
  } | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  // Row clicked in the table: it is under the pointer, no need to scroll to it.
  const [pickedRowId, setPickedRowId] = useState<string | null>(null);
  // New active itinerary (picked here or elsewhere): unfold the branches hiding it.
  const [trackedActiveId, setTrackedActiveId] = useState(activeItineraryId);
  if (trackedActiveId !== activeItineraryId) {
    setTrackedActiveId(activeItineraryId);
    if (pickedRowId !== activeItineraryId) setPickedRowId(null);
    if (activeItineraryId) {
      const hidingIds = findSummaryAncestorIds(summaryTree, activeItineraryId).filter((id) => collapsedIds.has(id));
      if (hidingIds.length > 0) {
        setCollapsedIds((current) => {
          const next = new Set(current);
          hidingIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }

  const followActiveRow = pickedRowId !== activeItineraryId;
  useCenterActiveSummaryRow(rowsRef, activeItineraryId, itineraries.length, fullscreen ? 'fullscreen' : 'dock', followActiveRow);

  const selectedItinerary = menuState
    ? itineraries.find((itinerary) => itinerary.id === menuState.itineraryId) ?? null
    : null;
  const editingItinerary = editingState
    ? itineraries.find((itinerary) => itinerary.id === editingState.itineraryId) ?? null
    : null;

  // Menu, renommage et repli d'un itinéraire disparu (supprimé, annulé) :
  // oubliés dans ce rendu.
  if (menuState && !selectedItinerary) setMenuState(null);
  if (editingState && !editingItinerary) setEditingState(null);
  const [collapsedFor, setCollapsedFor] = useState(itineraries);
  if (collapsedFor !== itineraries) {
    setCollapsedFor(itineraries);
    const validIds = new Set(itineraries.map((itinerary) => itinerary.id));
    setCollapsedIds((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : current;
    });
  }

  const handleToggleFullscreen = () => {
    // An open menu or rename is placed for the panel being left.
    setMenuState(null);
    setEditingState(null);
    onToggleFullscreen?.();
  };

  const handleOpenMenu = (itinerary: Itinerary, anchorEl: HTMLButtonElement) => {
    setMenuState((current) => {
      if (current && current.itineraryId === itinerary.id && current.anchorEl === anchorEl) {
        return null;
      }
      return {
        itineraryId: itinerary.id,
        anchorEl,
      };
    });
  };

  const handleCloseMenu = () => setMenuState(null);

  const handleToggleExpanded = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStartRename = (itinerary: Itinerary) => {
    setMenuState(null);
    setEditingState({ itineraryId: itinerary.id, draft: itinerary.name });
  };

  const handleCommitRename = () => {
    if (!editingState) return;
    const trimmed = editingState.draft.trim();
    if (trimmed) {
      store?.setItineraryName(editingState.itineraryId, trimmed);
    }
    setEditingState(null);
  };

  const handleCancelRename = () => setEditingState(null);

  const handleDuplicate = () => {
    if (!selectedItinerary) return;
    store?.duplicateItinerary(selectedItinerary.id);
    trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'duplicate' } });
    setMenuState(null);
  };

  const handleDelete = () => {
    if (!selectedItinerary) return;
    store?.removeItinerary(selectedItinerary.id);
    setMenuState(null);
  };

  const handleSelectForMerge = (itineraryId: string) => {
    routeMergeTool?.selectItinerary(itineraryId);
  };

  const handleSelectItinerary = useCallback(
    (itineraryId: string) => {
      setPickedRowId(itineraryId);
      // La sélection ne touche pas à la visibilité (œil indépendant).
      store?.setProject((p) => ({ ...p, activeItineraryId: itineraryId }));
    },
    [store],
  );

  const fullscreenLabel = fullscreen ? t('Quitter le plein écran') : t('Ouvrir en plein écran');

  return (
    <>
      <section
        className="rvc-center-summary"
        aria-label={t("Synthèse d'itinéraire")}
      >
        <div className="rvc-center-summary__row rvc-center-summary__row--header">
          <div className="rvc-center-summary__title">{t('Synthèse')}</div>
          <div className="rvc-center-summary__metrics" aria-hidden="true">
            {HEADER_CELLS.map((cell, index) => (
              <div
                key={`header-${index}-${cell}`}
                className="rvc-center-summary__metric rvc-center-summary__metric--header"
                title={t(cell)}
              >
                {t(cell)}
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`rvc-center-summary__ghost-button rvc-center-summary__fullscreen-toggle${fullscreen ? ' is-active' : ''}`}
            onClick={handleToggleFullscreen}
            aria-label={fullscreenLabel}
            title={fullscreenLabel}
            aria-pressed={fullscreen}
          >
            <IconMaximize size={16} />
          </button>
        </div>

        <div
          ref={rowsRef}
          className="rvc-center-summary__rows"
        >
          {itineraries.length === 0 ? (
            <EmptyRow />
          ) : (
            summaryTree.map((branch) => (
              <SummaryTreeBranch
                key={branch.node.itinerary.id}
                branch={branch}
                collapsedIds={collapsedIds}
                editingState={editingState}
                mergeArmed={routeMergeTool?.armed ?? false}
                mergeSelectable={(id) => routeMergeTool?.canSelectItinerary(id) ?? false}
                mergeSelectionOrder={(id) => routeMergeTool?.getSelectionOrder(id) ?? null}
                activeItineraryId={activeItineraryId}
                onSelectItinerary={handleSelectItinerary}
                onToggleAnalysisVisibility={handleToggleAnalysisVisibility}
                onToggleExpanded={handleToggleExpanded}
                onStartRename={handleStartRename}
                onRenameDraftChange={(draft) =>
                  setEditingState((current) => (current ? { ...current, draft } : current))
                }
                onCommitRename={handleCommitRename}
                onCancelRename={handleCancelRename}
                onSelectForMerge={handleSelectForMerge}
                onOpenMenu={handleOpenMenu}
              />
            ))
          )}
        </div>
      </section>

      {menuState && selectedItinerary ? (
        <SummaryActionMenu
          itinerary={selectedItinerary}
          anchorEl={menuState.anchorEl}
          canDelete={true}
          onClose={handleCloseMenu}
          onStartRename={() => handleStartRename(selectedItinerary)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      ) : null}
    </>
  );
}
