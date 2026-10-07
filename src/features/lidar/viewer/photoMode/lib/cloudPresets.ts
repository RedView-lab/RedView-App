// ============================================
// Photo mode — cloud scenes and the cloud layer they resolve to
// ============================================
//
// One layer of static clouds between a base and a top altitude, around the
// scene only (the field fades out ~13 km away: the whole ray budget goes to
// the clouds that are seen large). Cumulus are towers on a jittered grid of
// cells (the cell size of the genus), carved by 3D noise; layer clouds are
// broad patches. Thicknesses and extinctions are those of the real genera
// (WMO cloud atlas: cumulus humilis < 1 km, congestus towers 3–7 km,
// cumulonimbus up to the tropopause; liquid water 0.3–0.6 g/m³ with 10 µm
// droplets: extinction 3·LWC / (2·ρ·r_eff) ≈ 0.05–0.1 /m, visibility inside
// a cumulus 20–50 m).
// Above the volumetric layer, Nubis' "cirrus sub-layer" (Schneider, "Nubis,
// Evolved", 2022): thin 2.5-D sheets of mid and high clouds — altocumulus
// cells around 5–6 km, cirrus fibres around 9–10 km — that reach the
// horizon and catch the reddened light of the low sun (and still glow after
// it set on the ground).

import type { CloudPresetId, PhotoModeState } from '../types';

export interface CloudPreset {
  /** Panel label (French source text, translated by the i18n pairs). */
  label: string;
  /** Default cover, 0–100. */
  coverage: number;
  /** 0 = stratus (flat patches) … 1 = cumulus (domes). */
  type: number;
  thicknessM: number;
  /** Extinction at the core of a cloud, 1/m. */
  extinction: number;
  /** Share of the extinction that is absorbed (darker storm clouds). */
  absorption: number;
  /** Shift of the cloud base from the automatic altitude (m). */
  baseShiftM: number;
  /** Seed of the weather map. */
  seed: number;
  /** Spacing of the cumulus cells (m). */
  cellSizeM: number;
  /** Cumulonimbus anvil spreading under the top of the layer (0/1). */
  anvil: number;
  /** Mid (altocumulus) and high (cirrus) sub-layers at the default cover. */
  alto: HighCloudPreset;
  cirrus: HighCloudPreset;
}

interface HighCloudPreset {
  /** 0–1 (scaled with the cover slider). */
  coverage: number;
  /** 0 = streaks (cirrus fibres) … 0.5 = wisps … 1 = round cells (altocumulus). */
  type: number;
}

const NO_HIGH: HighCloudPreset = { coverage: 0, type: 0 };

export const CLOUD_PRESETS: Readonly<Record<CloudPresetId, CloudPreset>> = {
  clear: { label: 'Ciel dégagé', coverage: 0, type: 0.9, thicknessM: 1000, extinction: 0.09, absorption: 0, baseShiftM: 0, seed: 1, cellSizeM: 1500, anvil: 0, alto: NO_HIGH, cirrus: NO_HIGH },
  fair: {
    label: 'Beau temps', coverage: 25, type: 0.9, thicknessM: 1000, extinction: 0.08, absorption: 0, baseShiftM: 0, seed: 2, cellSizeM: 1500, anvil: 0,
    alto: NO_HIGH, cirrus: { coverage: 0.55, type: 0.15 },
  },
  cumulus: {
    label: 'Cumulus', coverage: 30, type: 1, thicknessM: 4500, extinction: 0.1, absorption: 0, baseShiftM: 0, seed: 3, cellSizeM: 2600, anvil: 0,
    alto: { coverage: 0.35, type: 0.9 }, cirrus: { coverage: 0.4, type: 0.2 },
  },
  overcast: {
    label: 'Couvert', coverage: 85, type: 0.3, thicknessM: 800, extinction: 0.07, absorption: 0.02, baseShiftM: -300, seed: 4, cellSizeM: 1800, anvil: 0,
    alto: { coverage: 0.7, type: 0.5 }, cirrus: NO_HIGH,
  },
  storm: {
    label: 'Orageux', coverage: 45, type: 1, thicknessM: 7000, extinction: 0.12, absorption: 0.1, baseShiftM: -300, seed: 5, cellSizeM: 7500, anvil: 1,
    alto: NO_HIGH, cirrus: { coverage: 0.6, type: 0.45 },
  },
};

export const CLOUD_PRESET_IDS = Object.keys(CLOUD_PRESETS) as CloudPresetId[];

/** Lowest cloud base above the scene's lowest ground (m): clouds may wrap the peaks, not lie on the valley floor. */
const MIN_BASE_ABOVE_GROUND_M = 150;
/** Highest cloud base above the automatic one (m). */
const MAX_CLOUD_BASE_OFFSET_M = 6000;

/**
 * Automatic cloud base (absolute altitude, m): low, among the relief —
 * about halfway up the scene's slopes (at least 450 m above its lowest
 * ground), so that the clouds float at the height of the ridges and are seen
 * large and close rather than as a ceiling far above the summits.
 */
export function defaultCloudBaseAltitude(sceneMinAltM: number, sceneMaxAltM: number): number {
  const relief = Math.max(0, sceneMaxAltM - sceneMinAltM);
  const base = sceneMinAltM + Math.max(450, 0.45 * relief);
  return Math.round(base / 50) * 50;
}

/** Bounds of the base offset slider for a scene (m). */
export function cloudBaseOffsetRange(sceneMinAltM: number, sceneMaxAltM: number): { min: number; max: number } {
  const auto = defaultCloudBaseAltitude(sceneMinAltM, sceneMaxAltM);
  return { min: Math.min(0, Math.round(sceneMinAltM + MIN_BASE_ABOVE_GROUND_M - auto)), max: MAX_CLOUD_BASE_OFFSET_M };
}

/** The cloud layer drawn by the renderer. */
export interface CloudLayer {
  /** 0–1; 0 skips the clouds. */
  coverage: number;
  type: number;
  baseAltitudeM: number;
  topAltitudeM: number;
  extinction: number;
  absorption: number;
  seed: number;
  cellSizeM: number;
  anvil: number;
  /** Altocumulus and cirrus sub-layers. */
  high: [HighCloudLayer, HighCloudLayer];
}

/** A thin 2.5-D sub-layer above the volumetric clouds. */
export interface HighCloudLayer {
  baseAltitudeM: number;
  thicknessM: number;
  /** 0–1; 0 skips it. */
  coverage: number;
  /** 0 = streaks … 1 = round cells. */
  type: number;
}

/** Altitudes (m) and thicknesses of the sub-layers: above the towers' reach where possible. */
const ALTO_BASE_M = 3600;
const ALTO_THICKNESS_M = 400;
const CIRRUS_BASE_M = 6200;
const CIRRUS_THICKNESS_M = 600;

export interface SceneAltitudes {
  minAltM: number;
  maxAltM: number;
}

export function resolveCloudLayer(
  state: Pick<PhotoModeState, 'clouds' | 'coverage' | 'cloudBaseOffsetM'>,
  scene: SceneAltitudes,
): CloudLayer {
  const preset = CLOUD_PRESETS[state.clouds] ?? CLOUD_PRESETS.cumulus;
  const range = cloudBaseOffsetRange(scene.minAltM, scene.maxAltM);
  const offset = Math.max(range.min, Math.min(range.max, state.cloudBaseOffsetM));
  const base = defaultCloudBaseAltitude(scene.minAltM, scene.maxAltM) + preset.baseShiftM + offset;
  const floor = scene.minAltM + MIN_BASE_ABOVE_GROUND_M;
  const baseAltitudeM = Math.max(floor, base);
  return {
    coverage: Math.max(0, Math.min(1, state.coverage / 100)),
    type: preset.type,
    baseAltitudeM,
    topAltitudeM: baseAltitudeM + preset.thicknessM,
    extinction: preset.extinction,
    absorption: preset.absorption,
    seed: preset.seed,
    cellSizeM: preset.cellSizeM,
    anvil: preset.anvil,
    high: [
      { baseAltitudeM: Math.max(ALTO_BASE_M, baseAltitudeM + 1200), thicknessM: ALTO_THICKNESS_M, coverage: highCover(preset.alto, preset, state.coverage), type: preset.alto.type },
      { baseAltitudeM: Math.max(CIRRUS_BASE_M, baseAltitudeM + 3200), thicknessM: CIRRUS_THICKNESS_M, coverage: highCover(preset.cirrus, preset, state.coverage), type: preset.cirrus.type },
    ],
  };
}

/** Anything to trace: the volumetric layer or a sub-layer. */
export function hasClouds(layer: Pick<CloudLayer, 'coverage' | 'high'>): boolean {
  return layer.coverage > 0 || layer.high.some((high) => high.coverage > 0);
}

/** The sub-layers follow the cover slider (relative to the preset's default cover). */
function highCover(high: HighCloudPreset, preset: CloudPreset, coverage: number): number {
  if (high.coverage <= 0) return 0;
  const scale = preset.coverage > 0 ? coverage / preset.coverage : 1;
  return Math.max(0, Math.min(1, high.coverage * Math.min(1.5, scale)));
}
