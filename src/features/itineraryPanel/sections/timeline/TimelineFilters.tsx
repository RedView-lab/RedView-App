export interface TimelineFilterState {
  etape: boolean;
  waypoint: boolean;
  poi: boolean;
  pause: boolean;
  favorite: boolean;
  categories?: Set<string>;
}

export const DEFAULT_TIMELINE_FILTER: TimelineFilterState = {
  etape: true,
  waypoint: true,
  poi: true,
  pause: true,
  favorite: true,
};
