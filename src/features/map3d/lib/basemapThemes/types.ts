/**
 * Une couleur, ou une rampe de zoom `[[zoom, couleur], …]` interpolée
 * linéairement. Les rampes servent là où une entité doit se lire différemment
 * de loin (trait fin, besoin de contraste) et de près (trait large avec son
 * propre liseré).
 */
export type ColorRamp = string | ReadonlyArray<readonly [number, string]>;

type BasemapTone = 'light' | 'dark';

/**
 * Toutes les décisions de couleur d'un fond de carte RedView. Une palette = un
 * thème : la correspondance des calques de `buildThemeOverrides` est partagée,
 * donc les deux thèmes gardent la même hiérarchie et seul le langage des
 * couleurs change.
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
  /** Copie décalée sous l'eau : se lit comme une fine ligne de rivage. */
  waterShadow: string;
  waterway: string;
  waterDepth: { shallow: string; deep: string };
  wetland: string;
  wetlandPatternOpacity: number;

  hillshade: {
    shadow: string;
    highlight: string;
    /** Le relief reste à pleine intensité jusqu'à ce zoom… */
    fadeStartZoom: number;
    /** …et disparaît à celui-ci (les bâtiments prennent le relais au sol). */
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
    /** Halo dessiné sous chaque chemin pour que les tirets se lisent sur tout fond. */
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
