import {
  useEffect,
  useState,
  useMemo,
} from 'react';
import { useAppI18n } from '@/shared/i18n';
import { useRouteMergeToolOptional } from '@/features/centerPanel/routeMerge';
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
} from './summary-utils';
import type { InlineRenameState } from './types';

export function CenterPanelSummary() {
  const { t } = useAppI18n();
  const store = useProjectStoreOptional();
  const routeMergeTool = useRouteMergeToolOptional();
  const itineraries = store?.project.itineraries ?? [];
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

  const selectedItinerary = menuState
    ? itineraries.find((itinerary) => itinerary.id === menuState.itineraryId) ?? null
    : null;
  const editingItinerary = editingState
    ? itineraries.find((itinerary) => itinerary.id === editingState.itineraryId) ?? null
    : null;

  useEffect(() => {
    if (menuState && !selectedItinerary) {
      setMenuState(null);
    }
  }, [menuState, selectedItinerary]);

  useEffect(() => {
    if (editingState && !editingItinerary) {
      setEditingState(null);
    }
  }, [editingItinerary, editingState]);

  useEffect(() => {
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
  }, [itineraries]);

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

  return (
    <section className="rvc-center-summary" aria-label={t("Synthèse d'itinéraire")}>
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
      </div>

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
    </section>
  );
}
