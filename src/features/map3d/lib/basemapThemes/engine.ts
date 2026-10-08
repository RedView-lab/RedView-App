import type { BasemapPalette, ColorRamp } from './types';

type StyleDefinition = Record<string, unknown>;
type Expression = unknown;

interface LayerOverride {
  paint?: Record<string, Expression>;
  layout?: Record<string, Expression>;
}

type LayerOverrides = Record<string, LayerOverride>;

const ROAD_STRUCTURES = ['road', 'bridge', 'tunnel'] as const;

/**
 * Les courbes de niveau propres à Outdoors sont retirées : elles relèvent du
 * contrôle « Courbes de niveau » (intervalle / opacité, `features/contourLines`).
 */
const REMOVED_LAYER_IDS: ReadonlySet<string> = new Set(['contour-line', 'contour-label']);

function color(ramp: ColorRamp): Expression {
  if (typeof ramp === 'string') return ramp;
  return ['interpolate', ['linear'], ['zoom'], ...ramp.flat()];
}

function colorAtStop(ramp: ColorRamp, zoom: number): string {
  if (typeof ramp === 'string') return ramp;
  let picked = ramp[0][1];
  for (const [stopZoom, stopColor] of ramp) {
    if (stopZoom <= zoom) picked = stopColor;
  }
  return picked;
}

/**
 * `match` sur une propriété d'entité dont les branches peuvent être des rampes
 * de zoom. La spécification de style n'autorise `zoom` qu'au premier niveau :
 * la rampe est donc remontée — un interpolate sur l'union des paliers, un
 * `match` par palier. Les rampes associées dans un même match doivent partager
 * leurs paliers (un palier manquant reprend le précédent).
 */
function matchRamp(property: string, cases: ReadonlyArray<readonly [string, ColorRamp]>, fallback: ColorRamp): Expression {
  const ramps = [...cases.map(([, ramp]) => ramp), fallback];
  const stops = [...new Set(ramps.flatMap((ramp) => (typeof ramp === 'string' ? [] : ramp.map(([z]) => z))))]
    .sort((a, b) => a - b);
  const matchAt = (zoom: number) => [
    'match', ['get', property],
    ...cases.flatMap(([value, ramp]) => [value, colorAtStop(ramp, zoom)]),
    colorAtStop(fallback, zoom),
  ];
  if (stops.length === 0) return matchAt(0);
  return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap((zoom) => [zoom, matchAt(zoom)])];
}

function byClass(cases: Record<string, string>, fallback: string): Expression {
  return ['match', ['get', 'class'], ...Object.entries(cases).flat(), fallback];
}

/** Rampe des icônes de POI d'Outdoors (conditionnée par sizerank), avec un plafond d'opacité propre au thème. */
function iconOpacity(max: number): Expression {
  return [
    'step', ['zoom'],
    ['step', ['get', 'sizerank'], 0, 5, max],
    17, ['step', ['get', 'sizerank'], 0, 13, max],
  ];
}

function label(textColor: Expression, halo: string, haloWidth = 1.2, haloBlur = 0.5): LayerOverride {
  return {
    paint: {
      'text-color': textColor,
      'text-halo-color': halo,
      'text-halo-width': haloWidth,
      'text-halo-blur': haloBlur,
    },
  };
}

function line(lineColor: Expression, extra: Record<string, Expression> = {}): LayerOverride {
  return { paint: { 'line-color': lineColor, ...extra } };
}

function fill(fillColor: Expression, extra: Record<string, Expression> = {}): LayerOverride {
  return { paint: { 'fill-color': fillColor, ...extra } };
}

function buildRoadOverrides(p: BasemapPalette): LayerOverrides {
  const r = p.roads;
  const motorwayTrunk = matchRamp('class', [['motorway', r.motorway]], r.trunk);
  const majorLink = matchRamp('class', [['motorway_link', r.motorway]], r.trunk);
  const street = matchRamp('class', [['street_limited', r.streetLimited]], r.street);
  const out: LayerOverrides = {};

  for (const s of ROAD_STRUCTURES) {
    const isTunnel = s === 'tunnel';
    const minorFill = isTunnel ? r.tunnelFill : color(r.minor);

    // Bordures. Les tunnels partagent une même bordure tiretée, plus claire.
    out[`${s}-motorway-trunk-case`] = line(isTunnel ? r.tunnelCase : r.motorwayCase);
    out[`${s}-major-link-case`] = line(isTunnel ? r.tunnelCase : r.motorwayCase);
    out[`${s}-primary-case`] = line(isTunnel ? r.tunnelCase : r.primaryCase);
    out[`${s}-secondary-tertiary-case`] = line(isTunnel ? r.tunnelCase : r.secondaryCase);
    out[`${s}-street-case`] = line(isTunnel ? r.tunnelCase : r.minorCase);
    out[`${s}-minor-case`] = line(isTunnel ? r.tunnelCase : r.minorCase);
    out[`${s}-minor-link-case`] = line(isTunnel ? r.tunnelCase : r.minorCase);

    // Fills.
    out[`${s}-motorway-trunk`] = line(motorwayTrunk);
    out[`${s}-major-link`] = line(majorLink);
    out[`${s}-primary`] = line(color(r.primary));
    out[`${s}-secondary-tertiary`] = line(isTunnel ? r.tunnelFill : color(r.secondary));
    out[`${s}-street`] = line(isTunnel ? r.tunnelFill : street);
    out[`${s}-street-low`] = line(isTunnel ? r.tunnelFill : color(r.street));
    out[`${s}-minor`] = line(minorFill);
    out[`${s}-minor-link`] = line(minorFill);
    out[`${s}-construction`] = line(r.construction);

    // Réseau piéton / cyclable. Les pistes cyclables sont le seul type de chemin
    // qu'un planificateur de bikepacking doit repérer immédiatement : teinte
    // propre, un peu plus large.
    out[`${s}-path-bg`] = line(['match', ['get', 'type'], 'piste', p.paths.pisteHalo, p.paths.halo]);
    out[`${s}-steps-bg`] = line(p.paths.halo);
    out[`${s}-path-trail`] = line(p.paths.trail);
    out[`${s}-path-cycleway-piste`] = line(
      ['match', ['get', 'type'], 'piste', p.paths.piste, p.paths.cycleway],
      { 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.7, 15, 1.7, 18, 4.5] },
    );
    out[`${s}-path`] = line(p.paths.path);
    out[`${s}-steps`] = line(p.paths.steps);
    out[`${s}-pedestrian`] = line(p.paths.pedestrian);
    out[`${s}-pedestrian-case`] = line(p.paths.pedestrianCase);
    out[`${s}-rail`] = line(p.rail);
    out[`${s}-rail-tracks`] = line(p.rail);
  }

  // Calques à double niveau propres aux ponts.
  out['bridge-motorway-trunk-2-case'] = line(r.motorwayCase);
  out['bridge-major-link-2-case'] = line(r.motorwayCase);
  out['bridge-motorway-trunk-2'] = line(motorwayTrunk);
  out['bridge-major-link-2'] = line(majorLink);

  out['road-polygon'] = fill(r.polygonFill, { 'fill-outline-color': r.polygonOutline });
  out['road-pedestrian-polygon-fill'] = fill(p.paths.pedestrianArea);
  out['turning-feature'] = { paint: { 'circle-color': r.polygonFill } };
  out['turning-feature-outline'] = {
    paint: { 'circle-color': r.polygonFill, 'circle-stroke-color': r.turningOutline },
  };
  out['golf-hole-line'] = line(p.paths.path);
  out.ferry = line(p.ferry);
  out['ferry-auto'] = line(p.ferry);
  out.aerialway = line(p.aerialway);
  out['gate-fence-hedge'] = line(p.fence);
  return out;
}

function buildLandOverrides(p: BasemapPalette): LayerOverrides {
  const c = p.landcover;
  const u = p.landuse;
  return {
    land: { paint: { 'background-color': p.land } },
    landcover: fill(
      byClass({ wood: c.wood, scrub: c.scrub, crop: c.crop, grass: c.grass, snow: c.snow }, c.fallback),
    ),
    'national-park': fill(p.nationalPark.fill, {
      'fill-opacity': [
        'interpolate', ['linear'], ['zoom'],
        5, 0,
        6, p.nationalPark.maxOpacity,
        12, p.nationalPark.maxOpacity * 0.35,
      ],
    }),
    'national-park_tint-band': line(p.nationalPark.band),
    landuse: fill([
      'match', ['get', 'class'],
      'wood', u.wood,
      'scrub', u.scrub,
      'agriculture', u.agriculture,
      'park', ['match', ['get', 'type'], ['garden', 'playground', 'zoo'], u.garden, u.park],
      'grass', u.grass,
      'airport', u.airport,
      'cemetery', u.cemetery,
      'glacier', u.glacier,
      'hospital', u.hospital,
      'pitch', u.pitch,
      'sand', u.sand,
      'rock', u.rock,
      'school', u.school,
      'commercial_area', u.commercial,
      'residential', u.residential,
      ['facility', 'industrial'], u.industrial,
      u.fallback,
    ]),
    'pitch-outline': line(p.pitchOutline),
    'land-structure-polygon': fill(p.land),
    'land-structure-line': line(p.structure),
    'aeroway-polygon': fill(p.aeroway),
    'aeroway-line': line(p.aeroway),
    building: fill(p.building, { 'fill-outline-color': p.buildingOutline }),
    'building-underground': fill(p.building),
    cliff: { paint: { 'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.25, p.cliffOpacity] } },
  };
}

function buildWaterOverrides(p: BasemapPalette): LayerOverrides {
  return {
    'water-shadow': fill(p.waterShadow),
    'waterway-shadow': line(p.waterShadow),
    water: fill(p.water),
    waterway: line(p.waterway),
    'water-depth': fill(
      ['interpolate', ['linear'], ['get', 'min_depth'], 0, p.waterDepth.shallow, 7000, p.waterDepth.deep],
      { 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 1, 8, 0] },
    ),
    wetland: fill(p.wetland),
    'wetland-pattern': fill(p.wetland, {
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 10.5, p.wetlandPatternOpacity],
    }),
  };
}

function buildTerrainOverrides(p: BasemapPalette): LayerOverrides {
  const h = p.hillshade;
  return {
    // Relief à la suisse : ombres froides, lumière chaude. La source Outdoors
    // empile plusieurs polygones `level`, d'où des alphas volontairement bas par polygone.
    hillshade: fill(['match', ['get', 'class'], 'shadow', h.shadow, h.highlight], {
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], h.fadeStartZoom, 1, h.fadeEndZoom, 0],
    }),
  };
}

function buildAdminOverrides(p: BasemapPalette): LayerOverrides {
  return {
    'admin-0-boundary-bg': line(p.admin.countryGlow),
    'admin-1-boundary-bg': line(p.admin.countryGlow),
    'admin-0-boundary': line(p.admin.country),
    'admin-0-boundary-disputed': line(p.admin.country),
    'admin-1-boundary': line(p.admin.state),
  };
}

function buildLabelOverrides(p: BasemapPalette): LayerOverrides {
  const l = p.labels;
  const poiText = [
    'match', ['get', 'class'],
    'food_and_drink', l.poi.food,
    'park_like', l.poi.park,
    'education', l.poi.education,
    'medical', l.poi.medical,
    'sport_and_leisure', l.poi.sport,
    l.poi.default,
  ];
  return {
    'settlement-major-label': label(l.placeMajor, l.halo, 1.4, 0.4),
    'settlement-minor-label': label(l.placeMinor, l.halo, 1.3, 0.4),
    'settlement-subdivision-label': label(l.placeSubdivision, l.halo, 1.2, 0.4),
    'country-label': label(l.country, l.halo, 1.4, 0.4),
    'continent-label': label(l.country, l.halo, 1.2, 0.4),
    'state-label': label(l.state, l.halo, 1.2, 0.4),
    'road-label': label(l.road, l.roadHalo, 1.3, 0.3),
    'path-pedestrian-label': label(l.road, l.roadHalo, 1.2, 0.3),
    'golf-hole-label': label(l.road, l.roadHalo, 1.2, 0.3),
    'ferry-aerialway-label': label(l.transit, l.halo),
    'transit-label': label(l.transit, l.halo),
    'airport-label': label(l.transit, l.halo),
    'waterway-label': label(l.water, l.waterHalo, 1.2, 0.4),
    'water-line-label': label(l.water, l.waterHalo, 1.2, 0.4),
    'water-point-label': label(l.water, l.waterHalo, 1.2, 0.4),
    'natural-line-label': label(l.peak, l.halo, 1.3, 0.4),
    'natural-point-label': {
      paint: { ...label(l.peak, l.halo, 1.3, 0.4).paint, 'icon-opacity': iconOpacity(l.poiIconOpacity) },
    },
    'poi-label': {
      paint: { ...label(poiText, l.halo, 1.2, 0.4).paint, 'icon-opacity': iconOpacity(l.poiIconOpacity) },
    },
    'building-entrance': label(l.placeSubdivision, l.halo, 1, 0.3),
    'building-number-label': label(l.placeSubdivision, l.halo, 1, 0.3),
    'block-number-label': label(l.placeSubdivision, l.halo, 1, 0.3),
    'gate-label': label(l.text, l.halo, 1, 0.3),
  };
}

export function buildThemeOverrides(palette: BasemapPalette): LayerOverrides {
  return {
    ...buildLandOverrides(palette),
    ...buildWaterOverrides(palette),
    ...buildTerrainOverrides(palette),
    ...buildRoadOverrides(palette),
    ...buildAdminOverrides(palette),
    ...buildLabelOverrides(palette),
  };
}

/**
 * Recolore sur place une définition de style Mapbox Outdoors v12 avec
 * `palette`. À part les courbes de niveau natives retirées, seules les
 * propriétés de peinture sont touchées : identifiants de calques, filtres,
 * sources et courbes de largeur selon le zoom restent ceux de Mapbox, pour que
 * la fonction des libellés (qui bascule les calques par motif d'identifiant) et
 * chaque overlay de l'app continuent de fonctionner sans changement.
 */
export function applyBasemapPalette(style: StyleDefinition, palette: BasemapPalette): StyleDefinition {
  const overrides = buildThemeOverrides(palette);
  const layers = (Array.isArray(style.layers) ? (style.layers as Array<Record<string, unknown>>) : [])
    .filter((layer) => !REMOVED_LAYER_IDS.has(layer.id as string));
  style.layers = layers;

  for (const layer of layers) {
    const id = typeof layer.id === 'string' ? layer.id : '';
    const override = overrides[id];
    if (!override) continue;
    if (override.paint) {
      layer.paint = { ...(layer.paint as Record<string, unknown> | undefined), ...override.paint };
    }
    if (override.layout) {
      layer.layout = { ...(layer.layout as Record<string, unknown> | undefined), ...override.layout };
    }
  }

  style.name = palette.name;
  return style;
}
