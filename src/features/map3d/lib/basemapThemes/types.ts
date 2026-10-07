/**
 * A colour, or a zoom ramp `[[zoom, colour], …]` interpolated linearly.
 * Ramps are used where a feature must read differently from afar (thin line,
 * needs contrast) and up close (wide line with its own casing).
 */
export type ColorRamp = string | ReadonlyArray<readonly [number, string]>;

type BasemapTone = 'light' | 'dark';

/**
 * Every colour decision of a RedView basemap. One palette = one theme: the
 * layer mapping in `buildThemeOverrides` is shared, so both themes keep the
 * same hierarchy and only the colour language changes.
 */
export interface BasemapPalette {
  tone: BasemapTone;
  name: string;

  land: string;
  landcover: {
    wood: string;
    scrub: string;
    crop: string;
    grass: string;
    snow: string;
    fallback: string;
  };
  landuse: {
    wood: string;
    scrub: string;
    agriculture: string;
    park: string;
    garden: string;
    grass: string;
    airport: string;
    cemetery: string;
    glacier: string;
    hospital: string;
    pitch: string;
    sand: string;
    rock: string;
    school: string;
    commercial: string;
    residential: string;
    industrial: string;
    fallback: string;
  };
  nationalPark: { fill: string; band: string; maxOpacity: number };

  water: string;
  /** Offset copy under the water: reads as a thin shoreline. */
  waterShadow: string;
  waterway: string;
  waterDepth: { shallow: string; deep: string };
  wetland: string;
  wetlandPatternOpacity: number;

  hillshade: {
    shadow: string;
    highlight: string;
    /** Relief stays at full strength up to this zoom… */
    fadeStartZoom: number;
    /** …and is gone at this one (buildings take over the ground). */
    fadeEndZoom: number;
  };
  cliffOpacity: number;

  building: string;
  buildingOutline: string;
  structure: string;
  pitchOutline: string;
  aeroway: string;
  fence: string;

  roads: {
    motorway: ColorRamp;
    trunk: ColorRamp;
    primary: ColorRamp;
    secondary: ColorRamp;
    street: ColorRamp;
    streetLimited: string;
    minor: ColorRamp;
    construction: string;
    motorwayCase: string;
    primaryCase: string;
    secondaryCase: string;
    minorCase: string;
    tunnelFill: string;
    tunnelCase: string;
    polygonFill: string;
    polygonOutline: string;
    turningOutline: string;
  };
  paths: {
    /** Halo drawn under every path so dashes read on any ground. */
    halo: string;
    pisteHalo: string;
    trail: string;
    cycleway: string;
    piste: string;
    path: string;
    steps: string;
    pedestrian: string;
    pedestrianCase: string;
    pedestrianArea: string;
  };
  rail: string;
  ferry: string;
  aerialway: string;

  admin: {
    country: string;
    countryGlow: string;
    state: string;
  };

  labels: {
    text: string;
    halo: string;
    placeMajor: string;
    placeMinor: string;
    placeSubdivision: string;
    country: string;
    state: string;
    road: string;
    roadHalo: string;
    peak: string;
    water: string;
    waterHalo: string;
    transit: string;
    poi: {
      default: string;
      food: string;
      park: string;
      education: string;
      medical: string;
      sport: string;
    };
    poiIconOpacity: number;
  };
}
