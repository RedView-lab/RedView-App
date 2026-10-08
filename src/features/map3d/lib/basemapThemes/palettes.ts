import type { BasemapPalette } from './types';

/*
 * Notes de conception communes aux deux palettes
 * ----------------------------------------------
 * - Le tracé de l'itinéraire est en rouge RedView : aucune entité du fond de
 *   carte n'utilise de rouge saturé, et les autoroutes sont du côté ambre pour
 *   ne jamais être lues comme un itinéraire.
 * - Hiérarchie qu'un cycliste lit en premier : relief (ombrage) → classe de
 *   route (grands axes chargés teintés, petites routes calmes neutres) →
 *   pistes cyclables (bleu canard) → sentiers (brun terre) → localités.
 * - Les lumières de la scène (`mapEnvironment`, « Jour ») rendent les calques
 *   2D à ~0,89 de leur couleur : la palette claire est donc réglée un peu plus
 *   claire que le rendu voulu à l'écran.
 */

/** "Papier topo": warm paper, crisp hierarchy, Swiss-style relief. */
export const TOPO_LIGHT_PALETTE: BasemapPalette = {
  tone: 'light',
  name: 'RedView Topo Clair',

  land: 'hsl(42, 36%, 97.5%)',
  landcover: {
    wood: 'hsla(118, 32%, 72%, 0.4)',
    scrub: 'hsla(95, 26%, 80%, 0.34)',
    crop: 'hsla(60, 36%, 86%, 0.3)',
    grass: 'hsla(92, 30%, 82%, 0.34)',
    snow: 'hsl(205, 45%, 98%)',
    fallback: 'hsla(100, 24%, 80%, 0.34)',
  },
  landuse: {
    wood: 'hsla(118, 32%, 72%, 0.4)',
    scrub: 'hsla(95, 26%, 80%, 0.34)',
    agriculture: 'hsla(60, 36%, 86%, 0.3)',
    park: 'hsl(105, 36%, 83%)',
    garden: 'hsl(105, 30%, 80%)',
    grass: 'hsla(92, 30%, 82%, 0.34)',
    airport: 'hsl(225, 18%, 90%)',
    cemetery: 'hsl(110, 18%, 84%)',
    glacier: 'hsl(200, 50%, 96%)',
    hospital: 'hsl(24, 28%, 92%)',
    pitch: 'hsl(100, 38%, 80%)',
    sand: 'hsl(46, 55%, 87%)',
    rock: 'hsla(35, 8%, 82%, 0.7)',
    school: 'hsl(40, 38%, 90%)',
    commercial: 'hsla(38, 34%, 91%, 0.8)',
    residential: 'hsl(35, 14%, 92%)',
    industrial: 'hsl(225, 12%, 90%)',
    fallback: 'hsl(42, 20%, 88%)',
  },
  nationalPark: { fill: 'hsl(125, 32%, 72%)', band: 'hsla(125, 34%, 62%, 0.55)', maxOpacity: 0.35 },

  water: 'hsl(204, 58%, 80%)',
  waterShadow: 'hsl(207, 48%, 66%)',
  waterway: 'hsl(204, 58%, 72%)',
  waterDepth: { shallow: 'hsla(204, 58%, 80%, 0)', deep: 'hsla(208, 55%, 62%, 0.4)' },
  wetland: 'hsl(180, 26%, 82%)',
  wetlandPatternOpacity: 0.7,

  hillshade: {
    shadow: 'hsla(228, 26%, 28%, 0.07)',
    highlight: 'hsla(48, 70%, 99%, 0.16)',
    fadeStartZoom: 14,
    fadeEndZoom: 16.5,
  },
  cliffOpacity: 0.8,

  building: 'hsl(36, 12%, 86%)',
  buildingOutline: 'hsl(34, 10%, 76%)',
  structure: 'hsl(36, 10%, 80%)',
  pitchOutline: 'hsl(100, 30%, 70%)',
  aeroway: 'hsl(225, 14%, 82%)',
  fence: 'hsl(35, 10%, 68%)',

  roads: {
    motorway: [[5, 'hsl(26, 66%, 62%)'], [9, 'hsl(28, 80%, 67%)'], [13, 'hsl(32, 92%, 72%)']],
    trunk: [[5, 'hsl(36, 70%, 60%)'], [9, 'hsl(40, 82%, 68%)'], [13, 'hsl(43, 90%, 76%)']],
    primary: [[6, 'hsl(44, 55%, 64%)'], [10, 'hsl(47, 82%, 78%)'], [13, 'hsl(49, 92%, 86%)']],
    secondary: [[8, 'hsl(36, 12%, 62%)'], [12, 'hsl(36, 14%, 76%)'], [14, 'hsl(0, 0%, 100%)']],
    street: [[12, 'hsl(36, 10%, 84%)'], [14, 'hsl(0, 0%, 100%)']],
    streetLimited: 'hsl(36, 14%, 92%)',
    minor: [[13, 'hsl(36, 10%, 84%)'], [15, 'hsl(0, 0%, 100%)']],
    construction: 'hsl(36, 12%, 80%)',
    motorwayCase: 'hsl(22, 48%, 52%)',
    primaryCase: 'hsl(40, 36%, 60%)',
    secondaryCase: 'hsl(34, 10%, 68%)',
    minorCase: 'hsl(34, 10%, 74%)',
    tunnelFill: 'hsl(36, 12%, 94%)',
    tunnelCase: 'hsl(34, 8%, 70%)',
    polygonFill: 'hsl(0, 0%, 100%)',
    polygonOutline: 'hsl(34, 10%, 74%)',
    turningOutline: 'hsl(34, 10%, 74%)',
  },
  paths: {
    halo: 'hsla(42, 40%, 99%, 0.9)',
    pisteHalo: 'hsla(212, 70%, 90%, 0.9)',
    trail: 'hsl(24, 58%, 40%)',
    cycleway: 'hsl(172, 72%, 32%)',
    piste: 'hsl(214, 72%, 48%)',
    path: 'hsl(26, 28%, 50%)',
    steps: 'hsl(26, 28%, 46%)',
    pedestrian: 'hsl(36, 14%, 94%)',
    pedestrianCase: 'hsl(34, 10%, 78%)',
    pedestrianArea: 'hsl(36, 16%, 91%)',
  },
  rail: 'hsl(222, 8%, 60%)',
  ferry: 'hsl(208, 60%, 52%)',
  aerialway: 'hsl(230, 12%, 42%)',

  admin: {
    country: 'hsl(292, 16%, 48%)',
    countryGlow: 'hsla(292, 40%, 82%, 0.55)',
    state: 'hsl(292, 10%, 62%)',
  },

  labels: {
    text: 'hsl(222, 16%, 26%)',
    halo: 'hsla(42, 33%, 98%, 0.94)',
    placeMajor: 'hsl(222, 26%, 13%)',
    placeMinor: 'hsl(222, 18%, 24%)',
    placeSubdivision: 'hsl(222, 12%, 44%)',
    country: 'hsl(222, 22%, 26%)',
    state: 'hsl(292, 12%, 44%)',
    road: 'hsl(222, 10%, 30%)',
    roadHalo: 'hsla(0, 0%, 100%, 0.95)',
    peak: 'hsl(24, 48%, 30%)',
    water: 'hsl(208, 58%, 34%)',
    waterHalo: 'hsla(204, 60%, 92%, 0.75)',
    transit: 'hsl(226, 26%, 36%)',
    poi: {
      default: 'hsl(222, 10%, 36%)',
      food: 'hsl(32, 70%, 32%)',
      park: 'hsl(112, 50%, 24%)',
      education: 'hsl(30, 50%, 30%)',
      medical: 'hsl(8, 52%, 40%)',
      sport: 'hsl(210, 56%, 36%)',
    },
    poiIconOpacity: 1,
  },
};

/**
 * « Nuit » : sol bleu ardoise profond (jamais noir pur, pour que le relief du
 * terrain et l'itinéraire rouge gardent leur profondeur), eau sombre, libellés
 * lumineux.
 */
export const TOPO_DARK_PALETTE: BasemapPalette = {
  tone: 'dark',
  name: 'RedView Topo Sombre',

  land: 'hsl(218, 18%, 16%)',
  landcover: {
    wood: 'hsla(160, 16%, 20.5%, 0.75)',
    scrub: 'hsla(152, 10%, 19.5%, 0.6)',
    crop: 'hsla(70, 6%, 19%, 0.45)',
    grass: 'hsla(140, 10%, 19.5%, 0.55)',
    snow: 'hsl(210, 22%, 36%)',
    fallback: 'hsla(150, 10%, 19.5%, 0.55)',
  },
  landuse: {
    wood: 'hsla(160, 16%, 20.5%, 0.75)',
    scrub: 'hsla(152, 10%, 19.5%, 0.6)',
    agriculture: 'hsla(70, 6%, 19%, 0.45)',
    park: 'hsl(156, 16%, 21%)',
    garden: 'hsl(156, 14%, 23%)',
    grass: 'hsla(140, 10%, 19.5%, 0.55)',
    airport: 'hsl(226, 18%, 22%)',
    cemetery: 'hsl(150, 12%, 21%)',
    glacier: 'hsl(205, 26%, 38%)',
    hospital: 'hsl(250, 8%, 22%)',
    pitch: 'hsl(145, 20%, 25%)',
    sand: 'hsl(42, 10%, 24%)',
    rock: 'hsla(215, 8%, 30%, 0.7)',
    school: 'hsl(230, 10%, 21.5%)',
    commercial: 'hsla(228, 18%, 21%, 0.8)',
    residential: 'hsl(220, 18%, 19.5%)',
    industrial: 'hsl(232, 16%, 21%)',
    fallback: 'hsl(220, 14%, 21%)',
  },
  nationalPark: { fill: 'hsl(150, 30%, 26%)', band: 'hsla(150, 34%, 34%, 0.5)', maxOpacity: 0.45 },

  water: 'hsl(213, 42%, 11%)',
  waterShadow: 'hsl(208, 36%, 26%)',
  waterway: 'hsl(206, 50%, 36%)',
  waterDepth: { shallow: 'hsla(213, 42%, 11%, 0)', deep: 'hsla(218, 50%, 6%, 0.5)' },
  wetland: 'hsl(190, 20%, 20%)',
  wetlandPatternOpacity: 0.25,

  hillshade: {
    shadow: 'hsla(226, 50%, 4%, 0.2)',
    highlight: 'hsla(210, 40%, 78%, 0.06)',
    fadeStartZoom: 14,
    fadeEndZoom: 16.5,
  },
  cliffOpacity: 0.35,

  building: 'hsl(220, 16%, 24%)',
  buildingOutline: 'hsl(220, 14%, 30%)',
  structure: 'hsl(220, 14%, 27%)',
  pitchOutline: 'hsl(145, 16%, 30%)',
  aeroway: 'hsl(226, 14%, 28%)',
  fence: 'hsl(220, 10%, 34%)',

  roads: {
    motorway: [[5, 'hsl(28, 58%, 44%)'], [10, 'hsl(30, 62%, 50%)'], [14, 'hsl(32, 60%, 54%)']],
    trunk: [[5, 'hsl(38, 44%, 40%)'], [10, 'hsl(40, 48%, 45%)'], [14, 'hsl(42, 46%, 50%)']],
    primary: [[6, 'hsl(44, 20%, 38%)'], [10, 'hsl(44, 24%, 45%)'], [14, 'hsl(44, 26%, 50%)']],
    secondary: [[8, 'hsl(220, 12%, 35%)'], [12, 'hsl(220, 12%, 41%)'], [15, 'hsl(220, 12%, 46%)']],
    street: [[12, 'hsl(220, 12%, 28%)'], [15, 'hsl(220, 12%, 34%)']],
    streetLimited: 'hsl(220, 12%, 27%)',
    minor: [[13, 'hsl(220, 12%, 30%)'], [16, 'hsl(220, 12%, 36%)']],
    construction: 'hsl(220, 10%, 30%)',
    motorwayCase: 'hsl(222, 26%, 10%)',
    primaryCase: 'hsl(222, 24%, 11%)',
    secondaryCase: 'hsl(222, 22%, 12%)',
    minorCase: 'hsl(222, 20%, 13%)',
    tunnelFill: 'hsl(220, 14%, 23%)',
    tunnelCase: 'hsl(220, 12%, 30%)',
    polygonFill: 'hsl(220, 12%, 30%)',
    polygonOutline: 'hsl(222, 20%, 13%)',
    turningOutline: 'hsl(222, 20%, 13%)',
  },
  paths: {
    halo: 'hsla(222, 26%, 11%, 0.75)',
    pisteHalo: 'hsla(214, 40%, 18%, 0.8)',
    trail: 'hsl(30, 55%, 62%)',
    cycleway: 'hsl(168, 62%, 50%)',
    piste: 'hsl(212, 70%, 66%)',
    path: 'hsl(30, 18%, 54%)',
    steps: 'hsl(30, 18%, 58%)',
    pedestrian: 'hsl(220, 12%, 29%)',
    pedestrianCase: 'hsl(222, 20%, 13%)',
    pedestrianArea: 'hsl(220, 14%, 23%)',
  },
  rail: 'hsl(222, 10%, 40%)',
  ferry: 'hsl(205, 50%, 46%)',
  aerialway: 'hsl(222, 12%, 58%)',

  admin: {
    country: 'hsl(284, 18%, 62%)',
    countryGlow: 'hsla(284, 30%, 42%, 0.35)',
    state: 'hsl(284, 8%, 46%)',
  },

  labels: {
    text: 'hsl(215, 20%, 80%)',
    halo: 'hsla(220, 28%, 9%, 0.88)',
    placeMajor: 'hsl(210, 32%, 95%)',
    placeMinor: 'hsl(214, 20%, 82%)',
    placeSubdivision: 'hsl(215, 12%, 62%)',
    country: 'hsl(214, 22%, 84%)',
    state: 'hsl(284, 12%, 66%)',
    road: 'hsl(215, 14%, 72%)',
    roadHalo: 'hsla(220, 28%, 10%, 0.9)',
    peak: 'hsl(30, 50%, 74%)',
    water: 'hsl(205, 52%, 64%)',
    waterHalo: 'hsla(213, 42%, 9%, 0.85)',
    transit: 'hsl(222, 30%, 76%)',
    poi: {
      default: 'hsl(215, 14%, 70%)',
      food: 'hsl(34, 60%, 66%)',
      park: 'hsl(140, 34%, 62%)',
      education: 'hsl(32, 36%, 66%)',
      medical: 'hsl(6, 56%, 70%)',
      sport: 'hsl(208, 56%, 70%)',
    },
    poiIconOpacity: 0.85,
  },
};
