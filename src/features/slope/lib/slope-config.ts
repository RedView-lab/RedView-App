import type { SlopeCategory, SlopeColorMode, SlopeState } from '../types';

// ── État par défaut ───────────────────────────────────────────────────

export const DEFAULT_SLOPE_STATE: SlopeState = {
  enabled: false,
  opacity: 0.5,
  colorMode: 'gradient',
  resolution: 'auto',
};

// ── Construction de l'expression raster-color ─────────────────────────
// Produit une expression interpolate ou step qui associe les degrés de pente
// à du RGBA. L'entrée est la valeur raster décodée via `raster-color-mix`.

// `["raster-value"]` renvoie la valeur décodée par raster-color-mix et bornée à
// raster-color-range, **dans les mêmes unités que la plage** (PAS normalisée à
// [0, 1]). Avec l'encodage en gamma racine (voir slope-source.ts), le SW écrit
// R = round(sqrt(deg/90) * 255) et raster-color-mix le décode en
// V = sqrt(deg/90) * 90 ∈ [0, 90]. Les positions des paliers de l'expression
// interpolate / step doivent donc s'exprimer dans ce même espace V, pas en
// degrés bruts : un seuil de catégorie à deg_k doit être placé à
// V_k = sqrt(deg_k/90) * 90 = sqrt(deg_k * 90).
//
// Le gamma racine concentre la précision de l'encodage sur les faibles pentes
// (la partie que l'utilisateur scrute vraiment). Mapbox interpole cependant les
// couleurs linéairement dans l'espace raster-value, c'est-à-dire selon
// sqrt(deg) : à 2,5° entre des paliers à 0° et 5°, il serait déjà à 71 % du
// chemin. Le dégradé reçoit donc GRADIENT_SUBSTEPS sous-paliers espacés en
// degrés par bande, pour que la couleur soit linéaire en degrés (comme dans la
// légende et la rampe du visualiseur LiDAR) à quelques pour cent de bande près,
// tandis que l'encodage garde sa précision.
export const MAX_SLOPE_DEG = 90;
const GRADIENT_SUBSTEPS = 6;

function degStop(deg: number): number {
  // Ramène un seuil en degrés dans l'espace raster-value (gamma racine).
  // Identité à 0° et à 90° (les deux ancrages), monotone entre les deux.
  if (deg <= 0) return 0;
  if (deg >= MAX_SLOPE_DEG) return MAX_SLOPE_DEG;
  return Math.sqrt(deg * MAX_SLOPE_DEG);
}

type Rgba = [number, number, number, number];

/** '#RRGGBB' → RGBA non prémultiplié (alpha 0..1) ; null pour tout le reste. */
function parseHexRgba(hex: string, alpha: number): Rgba | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, alpha];
}

function rgbaString([r, g, b, a]: Rgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Construit une expression raster-color Mapbox à partir d'une liste de
 * catégories.
 *
 * @param categories  Bandes de pente triées (minDeg croissant).
 * @param mode        'gradient' = interpolation douce entre les couleurs des bandes ;
 *                    'step'     = couleur unie par bande.
 * @param hiddenIds   Identifiants optionnels des catégories dont les pixels
 *                    doivent être entièrement transparents (bascules de
 *                    visibilité des bandes dans le panneau). Les bandes
 *                    masquées sont émises en paliers `'transparent'`, donc un
 *                    changement de visibilité n'invalide jamais de tuile — il
 *                    remplace l'expression de peinture sur place.
 */
export function buildSlopeColorExpression(
  categories: SlopeCategory[],
  mode: SlopeColorMode,
  hiddenIds?: ReadonlySet<string> | string[],
): unknown[] {
  const hidden = hiddenIds
    ? (hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds))
    : new Set<string>();
  const colorOf = (cat: SlopeCategory) =>
    hidden.has(cat.id) ? 'transparent' : cat.color;

  if (mode === 'step') {
    // Paliers : bandes à bords nets. La première bande commence à 0°, chaque
    // palier fixe la couleur de là jusqu'au seuil suivant.
    const expr: unknown[] = ['step', ['raster-value'], 'transparent'];
    for (const cat of categories) {
      expr.push(degStop(cat.minDeg), colorOf(cat));
    }
    return expr;
  }

  // Dégradé : interpolation linéaire (en degrés) entre les couleurs de début
  // des bandes. Les bandes masquées gardent leur couleur avec alpha 0 — le
  // fondu à la limite est celui du visualiseur LiDAR, visuellement plus joli
  // qu'une coupure nette.
  const expr: unknown[] = ['interpolate', ['linear'], ['raster-value']];
  categories.forEach((cat, index) => {
    expr.push(degStop(cat.minDeg), colorOf(cat));
    const next = categories[index + 1];
    if (!next || !(next.minDeg > cat.minDeg)) return;
    const from = parseHexRgba(cat.color, hidden.has(cat.id) ? 0 : 1);
    const to = parseHexRgba(next.color, hidden.has(next.id) ? 0 : 1);
    if (!from || !to) return;
    for (let k = 1; k < GRADIENT_SUBSTEPS; k++) {
      const t = k / GRADIENT_SUBSTEPS;
      const deg = cat.minDeg + (next.minDeg - cat.minDeg) * t;
      const rgba = from.map((channel, i) => channel + (to[i]! - channel) * t) as Rgba;
      expr.push(degStop(deg), rgbaString(rgba));
    }
  });
  // Prolonge la dernière couleur jusqu'à 90° pour ne jamais avoir de queue noire / transparente
  const last = categories[categories.length - 1];
  if (last.maxDeg < MAX_SLOPE_DEG) {
    expr.push(degStop(MAX_SLOPE_DEG), colorOf(last));
  }

  return expr;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Convertit des degrés en pourcentage approximatif (tan). Plafonné à 90° → ∞ */
function degToPercent(deg: number): string {
  if (deg >= 90) return '∞';
  return String(Math.round(Math.tan((deg * Math.PI) / 180) * 100));
}

export function percentToDeg(percent: number): number {
  if (!(percent > 0)) return 0;
  return Math.round((((Math.atan(percent / 100) * 180) / Math.PI) * 10)) / 10;
}

export function formatSlopeDegreeLabel(deg: number): string {
  const rounded = Math.round(deg * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ── Rampe de couleurs des bandes dynamiques ───────────────────────────

/**
 * Palettes dédiées par nombre de bandes : un échantillonnage uniforme d'une
 * seule rampe donne des extrêmes brutaux à faible N (vert → noir en 2
 * couleurs). Chaque palette part d'un vert émeraude, passe par jaune/ambre
 * puis rouge, et termine sur un bordeaux-prune (lisible sur fond satellite,
 * contrairement au noir).
 */
const SLOPE_PALETTES_BY_COUNT: Record<number, string[]> = {
  2: ['#2FB67C', '#E5484D'],
  3: ['#34B96A', '#F5B83D', '#D92D4A'],
  4: ['#34B96A', '#EFD43E', '#F0782E', '#B3204F'],
  5: ['#2FAF6A', '#A6D146', '#F5C93D', '#EF7430', '#B3204F'],
  6: ['#24A46A', '#8CCB45', '#F2D63F', '#F59A35', '#E24A3B', '#9E1C55'],
  8: ['#1E9A63', '#4DB960', '#A6D146', '#F2D63F', '#F6AE38', '#F07A2F', '#D93A40', '#8E1B58'],
  10: [
    '#17915F',
    '#35AD62',
    '#7DC54B',
    '#C3D843',
    '#F2D63F',
    '#F6B53A',
    '#F48A32',
    '#E65A36',
    '#C42A45',
    '#7A1A57',
  ],
};

/** Rampe continue de secours pour les nombres de bandes sans palette dédiée. */
const COLOR_RAMP = SLOPE_PALETTES_BY_COUNT[10];

/** Interpole une couleur hexadécimale entre deux couleurs hexadécimales. t ∈ [0, 1]. */
function lerpColor(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`.toUpperCase();
}

/** Choisit une couleur de la rampe pour la position t ∈ [0, 1]. */
function rampColor(t: number): string {
  const n = COLOR_RAMP.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const frac = t * n - i;
  return lerpColor(COLOR_RAMP[i], COLOR_RAMP[i + 1], frac);
}

/** Libellés de catégorie attribués selon la sévérité de la pente. */
const SEVERITY_LABELS = [
  'Quasi plat', 'Roulant', 'Soutenu', 'Raide', 'Mur', 'Extrême',
];

function severityLabel(index: number, total: number, minDeg?: number): string {
  if (minDeg !== undefined) {
    if (minDeg < 10) return 'Quasi plat';
    if (minDeg < 20) return 'Roulant';
    if (minDeg < 30) return 'Soutenu';
    if (minDeg < 40) return 'Raide';
    if (minDeg < 50) return 'Mur';
    return 'Extrême';
  }
  const i = Math.round((index / Math.max(total - 1, 1)) * (SEVERITY_LABELS.length - 1));
  return SEVERITY_LABELS[Math.min(i, SEVERITY_LABELS.length - 1)];
}

const DEFAULT_DEGREE_BREAKPOINTS_BY_COUNT: Record<number, number[]> = {
  2: [30],
  3: [15, 30],
  4: [15, 30, 45],
  5: [10, 20, 30, 45],
  6: [10, 20, 30, 40, 50],
  8: [10, 20, 25, 30, 35, 40, 50],
  10: [5, 10, 15, 20, 25, 30, 35, 40, 50],
};

const BREAKPOINT_STEP_DEG = 0.1;

function roundBreakpointDeg(value: number): number {
  return Math.round(value / BREAKPOINT_STEP_DEG) * BREAKPOINT_STEP_DEG;
}

// ── Validation des seuils ─────────────────────────────────────────────

/**
 * Pour `count` bandes, produit des seuils en degrés propres et intuitifs.
 * Renvoie un tableau de longueur `count - 1` (les limites entre les bandes).
 * Les limites implicites sont 0° à gauche et 90° à droite.
 */
function generateBreakpointsForCount(count: number): number[] {
  const preset = DEFAULT_DEGREE_BREAKPOINTS_BY_COUNT[count];
  if (preset) return [...preset];

  const step = 50 / count;
  const bp: number[] = [];
  for (let i = 1; i < count; i += 1) {
    bp.push(Math.round(step * i));
  }
  return bp;
}

/**
 * Valide et borne un tableau de seuils internes.
 *
 * @param breakpoints  Seuils bruts modifiés par l'utilisateur (longueur = bandCount - 1).
 *                     Implicite : band[0] commence à 0°, band[last] finit à 90°.
 * @param bandCount    Nombre total de bandes.
 * @returns            Seuils assainis, garantis strictement croissants dans (0, 90).
 */
export function clampBreakpoints(breakpoints: number[], bandCount: number): number[] {
  const n = bandCount - 1; // nombre de seuils internes

  // Cas dégénéré : une seule bande → aucun seuil interne
  if (n <= 0) return [];

  // Trop de bandes pour tenir avec des écarts ≥ 0,1° ? Repli sur un espacement régulier.
  if (n >= 900) return generateBreakpointsForCount(bandCount);

  // 1. Borne chaque valeur individuellement à [0.1, 89.9]
  const bp = breakpoints.slice(0, n).map((v) => {
    const rounded = roundBreakpointDeg(v);
    return Math.max(BREAKPOINT_STEP_DEG, Math.min(90 - BREAKPOINT_STEP_DEG, Number.isFinite(rounded) ? rounded : BREAKPOINT_STEP_DEG));
  });

  // Complète avec les valeurs par défaut s'il y a trop peu de valeurs
  while (bp.length < n) {
    const defaults = generateBreakpointsForCount(bandCount);
    bp.push(defaults[bp.length] ?? roundBreakpointDeg((bp[bp.length - 1] ?? 0) + BREAKPOINT_STEP_DEG));
  }

  // 2. Passe avant : garantit un ordre strictement croissant avec un écart ≥ 0,1°
  for (let i = 1; i < n; i++) {
    if (bp[i] <= bp[i - 1]) {
      bp[i] = roundBreakpointDeg(bp[i - 1] + BREAKPOINT_STEP_DEG);
    }
  }

  // 3. Si le dernier seuil dépasse 89,9°, passe arrière pour compresser
  if (bp[n - 1] > 90 - BREAKPOINT_STEP_DEG) {
    bp[n - 1] = 90 - BREAKPOINT_STEP_DEG;
    for (let i = n - 2; i >= 0; i--) {
      if (bp[i] >= bp[i + 1]) {
        bp[i] = roundBreakpointDeg(bp[i + 1] - BREAKPOINT_STEP_DEG);
      }
    }
  }

  // 4. Si le premier seuil passe sous 0,1°, l'espace est trop étroit.
  //    Repli sur un espacement régulier.
  if (bp[0] < BREAKPOINT_STEP_DEG) {
    return generateBreakpointsForCount(bandCount);
  }

  return bp;
}

/**
 * Génère N catégories de pente à partir d'un tableau de seuils internes.
 * breakpoints.length doit valoir count - 1.
 * Sans seuils fournis, des valeurs par défaut régulièrement espacées sont utilisées.
 */
export function generateDynamicCategories(
  count: number,
  customBreakpoints?: number[],
): SlopeCategory[] {
  // Construit le tableau complet des limites : [0, bp1, bp2, ..., 90]
  const bp = customBreakpoints && customBreakpoints.length === count - 1
    ? clampBreakpoints(customBreakpoints, count)
    : generateBreakpointsForCount(count);

  const boundaries = [0, ...bp, 90];

  return Array.from({ length: count }, (_, i) => {
    const minDeg = boundaries[i];
    const maxDeg = boundaries[i + 1];
    const minPct = degToPercent(minDeg);
    const maxPct = degToPercent(maxDeg);
    const pctRange = maxDeg >= 90 ? `>${minPct}%` : `${minPct}% - ${maxPct}%`;
    const label = severityLabel(i, count, minDeg);

    return {
      id: `band-${i}`,
      label,
      minDeg,
      maxDeg,
      color: SLOPE_PALETTES_BY_COUNT[count]?.[i] ?? rampColor(i / Math.max(count - 1, 1)),
      displayRange: pctRange,
    };
  });
}
