import type { PoiCategory } from '@/features/poi/types';
import type { MapContextMenuPoint } from '../MapContextMenu';
import type { PanelPlacement } from '../panelPlacement';

export interface MapPoiDraft {
  id: string;
  point: MapContextMenuPoint;
  screenPoint: {
    x: number;
    y: number;
  };
  name: string | null;
  favorite: boolean;
  category: PoiCategory | null;
  slopePct: number | null;
  surfaceLabel: string | null;
  roadTypeLabel: string | null;
  placement: PanelPlacement;
}

export type MapPoiDraftActionId =
  | 'toggle-favorite'
  | 'open-street-view'
  | 'change-category'
  | 'start-here'
  | 'add-waypoint'
  | 'finish-here'
  | 'delete'
  | 'close';

export interface MapPoiDraftActionPayload {
  action: MapPoiDraftActionId;
  draft: MapPoiDraft;
}