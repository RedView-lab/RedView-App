import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/components/SvgV2Icon';
import { useRouteMergeToolOptional } from '@/features/centerPanel/routeMerge';
import { Collapse } from '@/features/itineraryPanel/components/Collapse';
import {
  IconChevronDown,
  IconDotsVertical,
  IconEye,
  IconSettingsSliders,
} from './CenterPanelIcons';
import {
  useProjectStoreOptional,
  type Itinerary,
} from '@/features/itineraryPanel';
import {
  buildItineraryVisualNodes,
  type ItineraryVisualNode,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import { IconCopy04, IconTrash } from '@/features/itineraryPanel/components/icons';

const PLACEHOLDER = '--';
const MENU_WIDTH = 270;
const MENU_ROW_HEIGHT = 32;
const MENU_GAP = 6;

const HEADER_CELLS = [
  'Distance',
  'Durée',
  'Dénivelé /',
  'Dénivelé -',
  'Pente moyenne',
  'Tarmac',
  'Off-road',
  '7%',
  '7%',
  '7%',
];

function formatDistance(km: number | undefined): string {
  if (km == null || !Number.isFinite(km)) return PLACEHOLDER;
  return km.toFixed(2);
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return PLACEHOLDER;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatAscent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `+${Math.round(m)}`;
}

function formatDescent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `-${Math.round(m)}`;
}

function formatPercent(p: number | undefined): string {
  if (p == null || !Number.isFinite(p)) return PLACEHOLDER;
  return `${Math.round(p)}%`;
}

/**
 * Pull the active distance for an itinerary. Prefers the explicit
 * `metrics.distanceKm` (set by the BRouter recompute) but falls back to
 * the timeline "end" row's `distanceKm` for projects that pre-date the
 * `metrics` field.
 */
function itineraryDistanceKm(it: Itinerary): number | undefined {
  if (it.metrics?.distanceKm != null) return it.metrics.distanceKm;
  const endRow = it.timeline.find((r) => r.kind === 'end');
  return endRow?.distanceKm ?? undefined;
}

function buildValues(it: Itinerary): string[] {
  const m = it.metrics ?? {};
  return [
    formatDistance(itineraryDistanceKm(it)),
    formatDuration(m.durationSec),
    formatAscent(m.ascentM),
    formatDescent(m.descentM),
    formatPercent(m.avgSlopePercent),
    formatPercent(m.tarmacPercent),
    formatPercent(m.offroadPercent),
    PLACEHOLDER,
    PLACEHOLDER,
    PLACEHOLDER,
  ];
}

const EMPTY_VALUES: string[] = HEADER_CELLS.map(() => PLACEHOLDER);

interface SummaryRowProps {
  node: ItineraryVisualNode;
  childCount: number;
  expanded: boolean;
  isEditing: boolean;
  renameDraft: string;
  mergeArmed?: boolean;
  mergeSelectable?: boolean;
  mergeSelectionOrder?: number | null;
  onToggleAnalysisVisibility?: (id: string, visible: boolean) => void;
  onToggleExpanded?: (id: string) => void;
  onStartRename?: (itinerary: Itinerary) => void;
  onRenameDraftChange?: (value: string) => void;
  onCommitRename?: () => void;
  onCancelRename?: () => void;
  onSelectForMerge?: (itineraryId: string) => void;
  onOpenMenu?: (itinerary: Itinerary, anchorEl: HTMLButtonElement) => void;
}

function SummaryRow({
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
      title={depth > 0 ? `${itinerary.name} commence à ${startDistanceKm.toFixed(1)} km` : itinerary.name}
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
      <div
        className="rvc-center-summary__route"
        style={{ opacity: analysisVisible ? 1 : 0.45 }}
      >
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
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: itinerary.color }}
        />
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

function EmptyRow() {
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
          <div
            key={`empty-${index}`}
            className="rvc-center-summary__metric"
            title={cell}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label="Plus d'options"
        disabled
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

interface SummaryTreeNode {
  node: ItineraryVisualNode;
  children: SummaryTreeNode[];
}

interface InlineRenameState {
  itineraryId: string;
  draft: string;
}

interface SummaryTreeBranchProps {
  branch: SummaryTreeNode;
  collapsedIds: Set<string>;
  editingState: InlineRenameState | null;
  mergeArmed?: boolean;
  mergeSelectable?: (id: string) => boolean;
  mergeSelectionOrder?: (id: string) => number | null;
  onToggleAnalysisVisibility?: (id: string, visible: boolean) => void;
  onToggleExpanded: (id: string) => void;
  onStartRename: (itinerary: Itinerary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSelectForMerge?: (itineraryId: string) => void;
  onOpenMenu?: (itinerary: Itinerary, anchorEl: HTMLButtonElement) => void;
}

function SummaryTreeBranch({
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

interface SummaryActionMenuProps {
  itinerary: Itinerary;
  anchorEl: HTMLButtonElement;
  canDelete: boolean;
  onClose: () => void;
  onStartRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function SummaryActionMenu({
  itinerary,
  anchorEl,
  canDelete,
  onClose,
  onStartRename,
  onDuplicate,
  onDelete,
}: SummaryActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    scale: number;
    fontFamily: string;
    transformOrigin: string;
  } | null>(null);

  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorEl, onClose]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      firstActionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const computed = window.getComputedStyle(anchorEl);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const menuHeight = MENU_ROW_HEIGHT * 3 * scale;
      const gap = MENU_GAP * scale;
      const maxLeft = Math.max(8, window.innerWidth - MENU_WIDTH * scale - 8);
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const placeAbove = spaceBelow < menuHeight && rect.top > spaceBelow;

      setMenuStyle({
        top: placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap,
        left: Math.min(rect.left, maxLeft),
        scale,
        fontFamily: computed.fontFamily,
        transformOrigin: placeAbove ? 'bottom left' : 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(anchorEl);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorEl]);

  if (!menuStyle) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="rvc-center-summary__menu"
      role="menu"
      aria-label={`Actions pour ${itinerary.name}`}
      style={{
        top: menuStyle.top,
        left: menuStyle.left,
        width: MENU_WIDTH,
        transform: `scale(${menuStyle.scale})`,
        transformOrigin: menuStyle.transformOrigin,
        fontFamily: menuStyle.fontFamily,
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MapCanvasGlassBackdrop blur={34} saturate={1.85} tint="rgba(10, 10, 12, 0.46)" />

      <button
        ref={firstActionRef}
        type="button"
        className="rvc-center-summary__menu-item"
        role="menuitem"
        onClick={onStartRename}
      >
        <span className="rvc-center-summary__menu-label">Renommer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <SvgV2Icon name="edit-05.svg" size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rvc-center-summary__menu-item"
        role="menuitem"
        onClick={onDuplicate}
      >
        <span className="rvc-center-summary__menu-label">Dupliquer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <IconCopy04 size={16} />
        </span>
      </button>
      <button
        type="button"
        className="rvc-center-summary__menu-item rvc-center-summary__menu-item--danger"
        role="menuitem"
        onClick={onDelete}
        disabled={!canDelete}
      >
        <span className="rvc-center-summary__menu-label">Supprimer la trace</span>
        <span className="rvc-center-summary__menu-icon" aria-hidden>
          <IconTrash size={14} />
        </span>
      </button>
    </div>,
    document.body,
  );
}

function buildSummaryTree(visualNodes: ItineraryVisualNode[]): SummaryTreeNode[] {
  if (visualNodes.length === 0) return [];

  const branchById = new Map<string, SummaryTreeNode>();
  visualNodes.forEach((node) => {
    branchById.set(node.itinerary.id, { node, children: [] });
  });

  const roots: SummaryTreeNode[] = [];
  visualNodes.forEach((node) => {
    const branch = branchById.get(node.itinerary.id);
    if (!branch) return;
    const parentBranch = node.parentItineraryId ? branchById.get(node.parentItineraryId) : null;
    if (parentBranch) parentBranch.children.push(branch);
    else roots.push(branch);
  });

  return roots;
}

export function CenterPanelSummary() {
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
    <section className="rvc-center-summary" aria-label="Synthèse d'itinéraire">
      <div className="rvc-center-summary__row rvc-center-summary__row--header">
        <div className="rvc-center-summary__title">Synthèse</div>
        <div className="rvc-center-summary__metrics" aria-hidden="true">
          {HEADER_CELLS.map((cell) => (
            <div
              key={cell}
              className="rvc-center-summary__metric rvc-center-summary__metric--header"
              title={cell}
            >
              {cell}
            </div>
          ))}
        </div>
        <button
          className="rvc-center-summary__icon-button"
          type="button"
          aria-label="Réglages"
        >
          <IconSettingsSliders size={16} />
        </button>
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
          canDelete={itineraries.length > 1}
          onClose={handleCloseMenu}
          onStartRename={() => handleStartRename(selectedItinerary)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      ) : null}
    </section>
  );
}
