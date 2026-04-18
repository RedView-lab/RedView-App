/**
 * Types for the bottom-center "Central Panel" — route-comparison & analysis.
 *
 * Source of truth: Figma 1528:18338 ("RedView - Central panel").
 *
 * The panel is purely visual today; every datum comes through props so a
 * future container can hook into the routing engine, weather service and
 * Supabase project store without touching the view layer.
 *
 * Visual structure (top → bottom):
 *  1. Synthesis table — one row per itinerary, totals + surface percents.
 *  2. Analysis toolbar — X axis tabs, Y1/Y2 metric selectors, detail slider,
 *     overlay checkboxes (Waypoint, POI, Pause, Alertes, Pente, Jour/nuit).
 *  3. Profile chart — multi-series elevation/temperature/etc. over distance
 *     or time, with hover tooltips and overlay markers.
 *  4. Temperature rows — per-km value rows + "Ajouter" picker.
 *  5. Zoom scrollbar — horizontal range slider.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';

/** Shared categorical key types. */
export type AnalysisAxisX = 'distance' | 'time';

export type AnalysisAxisYMetric =
  | 'elevation'
  | 'temperature'
  | 'slope'
  | 'speed'
  | 'power'
  | 'heartrate'
  | 'humidity'
  | 'wind';

export type ChartOverlay =
  | 'waypoint'
  | 'poi'
  | 'pause'
  | 'alerts'
  | 'slope'
  | 'daynight';

export type ChartMarkerKind =
  | 'waypoint'
  | 'poi'
  | 'pause'
  | 'alert'
  | 'sun'
  | 'moon';

/* -------------------------------------------------------------------------- */
/* Synthesis (top table)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Stats summarising one itinerary. Each field is nullable so the row can
 * render dashes ("—") before the routing engine has produced a result.
 */
export interface ItineraryStats {
  distanceKm: number | null;
  durationSec: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  avgSlopePercent: number | null;
  surface: {
    /** All values are 0–100 percentages, summing to ≤ 100. */
    tarmac: number | null;
    gravel: number | null;
    offroad: number | null;
  };
  /** Free-form additional columns ("Confort", "Trafic"…) for future use. */
  extras?: Record<string, number | null>;
}

/* -------------------------------------------------------------------------- */
/* Profile chart series                                                       */
/* -------------------------------------------------------------------------- */

/** A single (x, y) sample on the profile chart. */
export interface ProfileSample {
  /** When axis1='distance', x is in km. When axis1='time', x is in seconds. */
  x: number;
  y: number;
}

/** A typed series, dashed/solid is decided by the renderer (primary vs y2). */
export interface ProfileSeries {
  metric: AnalysisAxisYMetric;
  samples: ProfileSample[];
}

/* -------------------------------------------------------------------------- */
/* Itinerary view-model passed into the panel                                 */
/* -------------------------------------------------------------------------- */

export interface CentralPanelItinerary {
  id: string;
  name: string;
  /** Hex color used for the legend square + curve color. */
  color: string;
  /** Eye toggle in the synthesis row. */
  visible: boolean;
  stats: ItineraryStats;
  /** Primary Y-axis (e.g., elevation) samples. Empty until route is solved. */
  primary?: ProfileSample[];
  /** Secondary Y-axis (e.g., temperature) samples. */
  secondary?: ProfileSample[];
  /**
   * Per-bin temperature values shown in the bottom rows.
   * Index aligns with the chart's X tick positions (km bins or time bins).
   */
  temperaturesC?: (number | null)[];
}

/* -------------------------------------------------------------------------- */
/* Chart markers / overlays                                                   */
/* -------------------------------------------------------------------------- */

export interface ChartMarker {
  id: string;
  itineraryId: string;
  kind: ChartMarkerKind;
  /** Position on the X axis, in the same unit as samples (km or s). */
  x: number;
  /** Optional vertical Y position; if undefined the marker rides the curve. */
  y?: number;
  label?: string;
}

/**
 * Day/night band shown behind the chart curves. Anchored to chart X.
 * Computed by the rhythm planner: sunrise/sunset along the route.
 */
export interface DayNightBand {
  itineraryId: string;
  fromX: number;
  toX: number;
  kind: 'day' | 'night';
}

/* -------------------------------------------------------------------------- */
/* Hover tooltip                                                              */
/* -------------------------------------------------------------------------- */

/** A single tooltip card (one per visible itinerary). */
export interface ChartHoverPoint {
  itineraryId: string;
  color: string;
  distanceKm: number;
  elevationGainM: number;
  elevationLossM: number;
  durationSec: number;
  /**
   * Day index from start (J1, J2…) and clock time (HH:MM) computed from
   * the rhythm planner. Optional so the tooltip degrades gracefully.
   */
  dayOffset?: number;
  clockHHMM?: string;
}

/* -------------------------------------------------------------------------- */
/* Top-level panel state (UI-only)                                            */
/* -------------------------------------------------------------------------- */

/** Toolbar / chart UI state, owned by the container. */
export interface CentralPanelUiState {
  axis1: AnalysisAxisX;
  axis1Mode: 'distance' | 'time';
  primaryMetric: AnalysisAxisYMetric;
  secondaryMetric: AnalysisAxisYMetric;
  /** 0..1 → density of samples / smoothing applied to the curves. */
  detail: number;
  overlays: Record<ChartOverlay, boolean>;
  /** [fromKm, toKm] when zoomed; null = full route. */
  zoomRangeKm: [number, number] | null;
}

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

export interface CentralPanelProps {
  itineraries: CentralPanelItinerary[];
  ui: CentralPanelUiState;
  markers?: ChartMarker[];
  dayNight?: DayNightBand[];

  className?: string;
  style?: CSSProperties;
  /** When provided, renders the bottom resize handle. */
  onResizeStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  /** Drag the panel's LEFT edge — used to push/shrink the left side panel. */
  onResizeLeftStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  /** Drag the panel's RIGHT edge — used to push/shrink the right side panel. */
  onResizeRightStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;

  /* ---- synthesis ------------------------------------------------------- */
  /**
   * Itinerary visually highlighted in the synthesis table (larger row, dark
   * background). Defaults to the first itinerary when omitted.
   */
  selectedItineraryId?: string | null;
  onSelectItinerary?: (itineraryId: string) => void;
  onToggleVisibility?: (itineraryId: string) => void;
  onRowAction?: (itineraryId: string, action: 'menu') => void;
  onOpenSettings?: () => void;

  /* ---- toolbar --------------------------------------------------------- */
  onChangeAxis1?: (next: AnalysisAxisX) => void;
  onChangePrimaryMetric?: (next: AnalysisAxisYMetric) => void;
  onChangeSecondaryMetric?: (next: AnalysisAxisYMetric) => void;
  onChangeDetail?: (value: number) => void;
  onToggleOverlay?: (overlay: ChartOverlay, enabled: boolean) => void;

  /* ---- chart hover ----------------------------------------------------- */
  onHover?: (xValue: number | null) => void;

  /* ---- temperature rows ----------------------------------------------- */
  onAddTemperatureRow?: () => void;
  onRemoveTemperatureRow?: (itineraryId: string) => void;
  onChangeTemperatureMode?: (
    itineraryId: string,
    mode: 'measured' | 'forecast' | 'custom',
  ) => void;

  /* ---- zoom scrollbar ------------------------------------------------- */
  onChangeZoom?: (range: [number, number] | null) => void;
}
