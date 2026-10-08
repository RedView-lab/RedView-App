import { clamp, lerp } from './types';

// ── Rampe de couleurs inspirée de Nullschool / Windy ───────────────────
// 12 paliers pour des dégradés très doux. Couleurs calibrées sur les palettes
// des visualisations météorologiques professionnelles.

const COLOR_STOPS: Array<{ speed: number; color: [number, number, number] }> = [
  { speed: 0,  color: [0.40, 0.55, 0.90] }, // pervenche douce (calme)
  { speed: 1,  color: [0.28, 0.58, 0.96] }, // bleu clair
  { speed: 3,  color: [0.12, 0.72, 0.92] }, // cyan
  { speed: 5,  color: [0.06, 0.82, 0.65] }, // vert sarcelle
  { speed: 7,  color: [0.08, 0.85, 0.35] }, // green
  { speed: 10, color: [0.50, 0.90, 0.12] }, // lime
  { speed: 13, color: [0.78, 0.92, 0.08] }, // vert-jaune
  { speed: 16, color: [0.98, 0.82, 0.05] }, // gold
  { speed: 20, color: [0.98, 0.55, 0.05] }, // orange
  { speed: 25, color: [0.95, 0.28, 0.08] }, // rouge-orangé
  { speed: 32, color: [0.88, 0.12, 0.15] }, // red
  { speed: 40, color: [0.72, 0.06, 0.42] }, // magenta (tempête)
];

/**
 * Interpole la rampe de couleurs de vitesse du vent avec un alpha adapté à la
 * vitesse. Renvoie [r, g, b, alpha] où l'alpha croît avec la vitesse pour
 * l'accent visuel.
 *
 * Le facteur de surbrillance de la pointe éclaircit le centre de la tête de
 * flèche d'environ 15 %, pour l'effet « pointe lumineuse » typique de Nullschool.
 */
export function interpolateColor(speed: number, tipHighlight = false): [number, number, number, number] {
  let r: number, g: number, b: number;

  if (speed <= COLOR_STOPS[0].speed) {
    [r, g, b] = COLOR_STOPS[0].color;
  } else if (speed >= COLOR_STOPS[COLOR_STOPS.length - 1].speed) {
    [r, g, b] = COLOR_STOPS[COLOR_STOPS.length - 1].color;
  } else {
    // Trouve les paliers qui encadrent et interpole
    r = COLOR_STOPS[0].color[0];
    g = COLOR_STOPS[0].color[1];
    b = COLOR_STOPS[0].color[2];
    for (let i = 1; i < COLOR_STOPS.length; i++) {
      const left = COLOR_STOPS[i - 1];
      const right = COLOR_STOPS[i];
      if (speed <= right.speed) {
        const t = (speed - left.speed) / (right.speed - left.speed);
        r = lerp(left.color[0], right.color[0], t);
        g = lerp(left.color[1], right.color[1], t);
        b = lerp(left.color[2], right.color[2], t);
        break;
      }
    }
  }

  // Alpha selon la vitesse : vent calme → plus transparent, fort → plus opaque
  const alpha = clamp(0.60 + speed * 0.015, 0.60, 0.92);

  // Pointe lumineuse façon Nullschool : pousse la couleur vers le blanc
  if (tipHighlight) {
    const boost = 0.15;
    r = Math.min(1, r + boost);
    g = Math.min(1, g + boost);
    b = Math.min(1, b + boost);
  }

  return [r, g, b, alpha];
}

/**
 * Alpha de la traînée à la position paramétrique t (0 = queue, 1 = tête).
 * Utilise un dégradé en t² pour une transition douce queue → tête avec halo de tête.
 */
export function trailAlpha(
  t: number,
  baseAlpha: number,
  fade: number,
  lifeRatio: number,
): number {
  // Fondu de sortie sur les derniers 15 % de vie pour éviter une disparition brutale
  const fadeOut = lifeRatio > 0.85 ? clamp((1 - lifeRatio) / 0.15, 0, 1) : 1;
  // Halo de tête : renforce les derniers 10 %
  const headGlow = t > 0.9 ? 1.2 : 1.0;
  // Dégradé en racine carrée : remplit davantage la traînée que t² tout en gardant un fondu de queue doux
  return baseAlpha * Math.sqrt(t) * fade * fadeOut * headGlow;
}
