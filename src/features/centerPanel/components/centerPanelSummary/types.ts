import type { Itinerary } from '@/features/itineraryPanel';
import type { ItineraryVisualNode } from '@/features/itineraryPanel/lineage/itineraryLineage';

export interface SummaryTreeNode {
  node: ItineraryVisualNode;
  children: SummaryTreeNode[];
}

export interface InlineRenameState {
  itineraryId: string;
  draft: string;
}

export interface SummaryRowMenuHandlers {
  onToggleAnalysisVisibility?: (id: string, visible: boolean) => void;
  onToggleExpanded?: (id: string) => void;
  onStartRename?: (itinerary: Itinerary) => void;
  onRenameDraftChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  onSelectForMerge?: (itineraryId: string) => void;
  onOpenMenu?: (itinerary: Itinerary, anchorEl: HTMLButtonElement) => void;
}