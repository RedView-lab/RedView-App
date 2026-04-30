import type { CSSProperties } from 'react';

import { Collapse } from '@/features/itineraryPanel/components/shell';
import type { ItineraryVisualNode } from '@/features/itineraryPanel/lineage/itineraryLineage';

import {
  IconChevronDown,
  IconDotsVertical,
  IconEye,
} from '../CenterPanelIcons';
import {
  EMPTY_VALUES,
  HEADER_CELLS,
  buildValues,
} from './summary-utils';
import type {
  InlineRenameState,
  SummaryRowMenuHandlers,
  SummaryTreeNode,
} from './types';

interface SummaryRowProps extends SummaryRowMenuHandlers {
  node: ItineraryVisualNode;
  childCount: number;
  expanded: boolean;
  isEditing: boolean;
  renameDraft: string;
  mergeArmed?: boolean;
  mergeSelectable?: boolean;
  mergeSelectionOrder?: number | null;
}

export function SummaryRow({
  node,
  childCount,
  expanded,
  isEditing,
  renameDraft,
  mergeArmed,
  mergeSelectable,
  mergeSelectionOrder,
  onToggleAnalysisVisibility,
  onToggleExpanded,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onSelectForMerge,
  onOpenMenu,
}: SummaryRowProps) {
  const { itinerary, depth, startDistanceKm } = node;
  const values = buildValues(itinerary);
  const analysisVisible = itinerary.analysisVisible !== false;
  const hasChildren = childCount > 0;
  const isMergeSelected = mergeSelectionOrder != null;
  const rowStyle =
    depth > 0
      ? ({
          '--rvc-center-summary-lineage-indent': `${Math.min(depth, 4) * 18}px`,
        } as CSSProperties)
      : undefined;
  const rowClassName = [
    depth > 0
      ? 'rvc-center-summary__row rvc-center-summary__row--item rvc-center-summary__row--child'
      : 'rvc-center-summary__row rvc-center-summary__row--item',
    mergeArmed ? 'rvc-center-summary__row--merge-armed' : '',
    isMergeSelected ? 'rvc-center-summary__row--merge-selected' : '',
    mergeArmed && !mergeSelectable ? 'rvc-center-summary__row--merge-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rowClassName}
      style={rowStyle}
      title={
        depth > 0
          ? `${itinerary.name} commence à ${startDistanceKm.toFixed(1)} km`
          : itinerary.name
      }
      onClick={mergeArmed && mergeSelectable ? () => onSelectForMerge?.(itinerary.id) : undefined}
      onKeyDown={
        mergeArmed && mergeSelectable
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelectForMerge?.(itinerary.id);
            }
          : undefined
      }
      role={mergeArmed && mergeSelectable ? 'button' : undefined}
      tabIndex={mergeArmed && mergeSelectable ? 0 : undefined}
      aria-pressed={mergeArmed && mergeSelectable ? isMergeSelected : undefined}
    >
      <div className="rvc-center-summary__route" style={{ opacity: analysisVisible ? 1 : 0.45 }}>
        {hasChildren ? (
          <button
            type="button"
            className="rvc-center-summary__tree-toggle"
            aria-label={expanded ? 'Replier les traces filles' : 'Déplier les traces filles'}
            aria-expanded={expanded}
            title={expanded ? 'Replier les traces filles' : 'Déplier les traces filles'}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded?.(itinerary.id);
            }}
          >
            <IconChevronDown size={12} />
          </button>
        ) : (
          <span className="rvc-center-summary__tree-toggle-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="rvc-center-summary__eye-button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleAnalysisVisibility?.(itinerary.id, !analysisVisible);
          }}
          aria-pressed={analysisVisible}
          aria-label={analysisVisible ? 'Masquer le graphique' : 'Afficher le graphique'}
          title={analysisVisible ? 'Masquer le graphique' : 'Afficher le graphique'}
          data-visible={analysisVisible ? 'true' : 'false'}
        >
          <IconEye size={14} />
        </button>
        <span className="rvc-center-summary__color" aria-hidden="true" style={{ background: itinerary.color }} />
        {mergeSelectionOrder != null ? (
          <span className="rvc-center-summary__merge-pill">{mergeSelectionOrder}</span>
        ) : null}
        {isEditing ? (
          <input
            className="rvc-center-summary__inline-input"
            value={renameDraft}
            onChange={(event) => onRenameDraftChange?.(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => onCommitRename?.()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommitRename?.();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancelRename?.();
              }
            }}
            aria-label={`Nouveau nom pour ${itinerary.name}`}
            autoFocus
          />
        ) : (
          <span
            className="rvc-center-summary__name"
            title={`${itinerary.name} · Double-cliquez pour renommer`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onStartRename?.(itinerary);
            }}
          >
            {itinerary.name}
          </span>
        )}
      </div>
      <div className="rvc-center-summary__metrics">
        {values.map((cell, index) => (
          <div
            key={`${itinerary.id}-${index}`}
            className="rvc-center-summary__metric"
            title={`${HEADER_CELLS[index]}: ${cell}`}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label={`Plus d'options pour ${itinerary.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu?.(itinerary, event.currentTarget);
        }}
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

export function EmptyRow() {
  return (
    <div className="rvc-center-summary__row rvc-center-summary__row--item">
      <div className="rvc-center-summary__route" style={{ opacity: 0.5 }}>
        <span className="rvc-center-summary__eye" aria-hidden="true">
          <IconEye size={14} />
        </span>
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: 'rgba(255,255,255,0.18)' }}
        />
        <span className="rvc-center-summary__name">Aucun itinéraire</span>
      </div>
      <div className="rvc-center-summary__metrics">
        {EMPTY_VALUES.map((cell, index) => (
          <div key={`empty-${index}`} className="rvc-center-summary__metric" title={cell}>
            {cell}
          </div>
        ))}
      </div>
      <button className="rvc-center-summary__ghost-button" type="button" aria-label="Plus d'options" disabled>
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

interface SummaryTreeBranchProps extends SummaryRowMenuHandlers {
  branch: SummaryTreeNode;
  collapsedIds: Set<string>;
  editingState: InlineRenameState | null;
  mergeArmed?: boolean;
  mergeSelectable?: (id: string) => boolean;
  mergeSelectionOrder?: (id: string) => number | null;
}

export function SummaryTreeBranch({
  branch,
  collapsedIds,
  editingState,
  mergeArmed,
  mergeSelectable,
  mergeSelectionOrder,
  onToggleAnalysisVisibility,
  onToggleExpanded,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onSelectForMerge,
  onOpenMenu,
}: SummaryTreeBranchProps) {
  const isEditing = editingState?.itineraryId === branch.node.itinerary.id;
  const expanded = !collapsedIds.has(branch.node.itinerary.id);

  return (
    <div className="rvc-center-summary__branch">
      <SummaryRow
        node={branch.node}
        childCount={branch.children.length}
        expanded={expanded}
        isEditing={isEditing}
        renameDraft={isEditing ? editingState?.draft ?? '' : ''}
        mergeArmed={mergeArmed}
        mergeSelectable={mergeSelectable?.(branch.node.itinerary.id) ?? false}
        mergeSelectionOrder={mergeSelectionOrder?.(branch.node.itinerary.id) ?? null}
        onToggleAnalysisVisibility={onToggleAnalysisVisibility}
        onToggleExpanded={onToggleExpanded}
        onStartRename={onStartRename}
        onRenameDraftChange={onRenameDraftChange}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
        onSelectForMerge={onSelectForMerge}
        onOpenMenu={onOpenMenu}
      />

      {branch.children.length > 0 ? (
        <Collapse open={expanded} className="rvc-center-summary__children">
          {branch.children.map((child) => (
            <SummaryTreeBranch
              key={child.node.itinerary.id}
              branch={child}
              collapsedIds={collapsedIds}
              editingState={editingState}
              mergeArmed={mergeArmed}
              mergeSelectable={mergeSelectable}
              mergeSelectionOrder={mergeSelectionOrder}
              onToggleAnalysisVisibility={onToggleAnalysisVisibility}
              onToggleExpanded={onToggleExpanded}
              onStartRename={onStartRename}
              onRenameDraftChange={onRenameDraftChange}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onSelectForMerge={onSelectForMerge}
              onOpenMenu={onOpenMenu}
            />
          ))}
        </Collapse>
      ) : null}
    </div>
  );
}