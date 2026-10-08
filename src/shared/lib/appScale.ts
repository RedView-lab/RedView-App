import type { CSSProperties } from 'react';

/**
 * Densité de l'interface (échelle du canvas), partagée par le tableau de bord
 * et le visualiseur LiDAR.
 *
 * L'interface est mise en page en pixels LOGIQUES (échelle typographique :
 * shared/styles/typography.css) et rendue à `appScale` pixels CSS par pixel
 * logique.
 *
 * Règle : sur un écran de densité standard, l'interface n'est JAMAIS réduite
 * sous 1:1. Un pixel CSS porte déjà la mise à l'échelle de l'OS de
 * l'utilisateur (125 %, 150 %…) et le zoom du navigateur ; réduire par-dessus
 * donnait du texte de 8 à 10 px, flou sur les écrans non HiDPI (fenêtre 1080p
 * en demi-écran, portable 1366×768, portable 1080p à 125–150 %). Les fenêtres
 * petites ou basses se réorganisent à la place (pages/Dashboard/lib/layout.ts :
 * les panneaux latéraux cèdent, le panneau central et les outils de carte se
 * compactent) ; le zoom du navigateur reste le réglage de densité de
 * l'utilisateur.
 *
 * Exception Retina (≥ 2 px physiques par px CSS : MacBook, 4K à 200 %) : un
 * texte réduit à 9,5 px CSS est encore dessiné sur 19 px physiques, net. Un
 * MacBook 13–14" (≈1440–1512 × 800–870 px CSS) en 1:1 paraissait
 * surdimensionné et tassait les barres d'outils de la carte et du centre sur
 * deux lignes : sous la référence de conception, l'échelle suit donc
 * HIDPI_SHRINK_FACTOR du déficit, jamais sous HIDPI_MIN (MacBook Air 13"
 * ≈ 0,87, MacBook Pro 14" ≈ 0,89).
 *
 * Au-dessus de la référence de conception (DESIGN), l'échelle croît doucement
 * (GROW_FACTOR de l'excédent) jusqu'à MAX : les écrans 1440p et ultralarges
 * gagnent en confort de lecture sans devenir un zoom géant. La largeur en plus
 * des ultralarges va à la carte, pas à un texte plus gros (l'ajustement
 * utilise l'axe limitant).
 *
 * L'échelle est appliquée avec le `zoom` CSS (voir `appScaleStyle`) : le texte
 * est mis en page et rastérisé à sa taille finale, les bordures s'alignent sur
 * les pixels physiques. Un `transform: scale()` ne fait que rééchantillonner le
 * rendu 1:1, ce qui floute le texte.
 */
export const APP_SCALE_DESIGN_WIDTH = 1920;
export const APP_SCALE_DESIGN_HEIGHT = 1080;
export const APP_SCALE_MAX = 1.12;
/** Part de l'excédent de la fenêtre (au-dessus de la référence de conception) appliquée à l'échelle. */
export const APP_SCALE_GROW_FACTOR = 0.55;
/**
 * Densité de pixels à partir de laquelle le canvas peut être réduit sous 1:1
 * (Retina). Lue avec une media query `resolution` : `window.devicePixelRatio`
 * est plafonné pour Mapbox (map3d/hooks/useMap/runtimeProfile.ts) et ne
 * reflète plus l'écran.
 */
const HIDPI_QUERY = '(min-resolution: 1.95dppx)';
/** Part du déficit de la fenêtre (sous la référence de conception) appliquée sur Retina. */
export const APP_SCALE_HIDPI_SHRINK_FACTOR = 0.5;
/** Plancher Retina : le plancher de texte de 11 px s'affiche à 9,35 px CSS, 18,7 px physiques. */
export const APP_SCALE_HIDPI_MIN = 0.85;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export interface AppScaleViewport {
  w: number;
  h: number;
  /** Écran d'au moins 2 px physiques par px CSS (Retina) ; faux si inconnu. */
  hiDpi?: boolean;
}

/** Taille et densité de pixels actuelles de la fenêtre, telles que `computeAppScale` les prend. */
export function readAppScaleViewport(): AppScaleViewport {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    hiDpi: window.matchMedia?.(HIDPI_QUERY).matches ?? false,
  };
}

/**
 * Appelle `onChange` quand la fenêtre est redimensionnée ou franchit le seuil
 * Retina (une fenêtre déplacée sur un écran d'une autre densité ne déclenche
 * aucun `resize`). Renvoie une fonction de nettoyage.
 */
export function watchAppScaleViewport(onChange: () => void): () => void {
  const media = window.matchMedia?.(HIDPI_QUERY) ?? null;
  media?.addEventListener('change', onChange);
  window.addEventListener('resize', onChange, { passive: true });
  return () => {
    window.removeEventListener('resize', onChange);
    media?.removeEventListener('change', onChange);
  };
}

export function computeAppScale(viewport: AppScaleViewport): number {
  const fitDesign = Math.min(
    viewport.w / APP_SCALE_DESIGN_WIDTH,
    viewport.h / APP_SCALE_DESIGN_HEIGHT,
  );
  if (!Number.isFinite(fitDesign)) return 1;
  let scale = 1;
  if (fitDesign > 1) {
    scale = clamp(1 + (fitDesign - 1) * APP_SCALE_GROW_FACTOR, 1, APP_SCALE_MAX);
  } else if (viewport.hiDpi) {
    scale = clamp(1 - (1 - fitDesign) * APP_SCALE_HIDPI_SHRINK_FACTOR, APP_SCALE_HIDPI_MIN, 1);
  }
  // Arrondi pour que les tailles de mise en page restent sur une grille décimale courte.
  return Math.round(scale * 1000) / 1000;
}

let standardZoomSupport: boolean | null = null;

/**
 * Vrai quand le `zoom` CSS suit le modèle normalisé (Chromium ≥ 128,
 * Firefox ≥ 126) : `getBoundingClientRect()` renvoie des valeurs zoomées
 * (visuelles) et `offsetWidth`/`clientWidth` des valeurs logiques, exactement
 * comme sous un ancêtre en `transform: scale()`, donc le code de pointeur /
 * de rectangles (Mapbox, menus, poignées de redimensionnement) fonctionne
 * tel quel. Les autres moteurs se replient sur la transformation.
 */
export function supportsStandardZoom(): boolean {
  if (standardZoomSupport != null) return standardZoomSupport;
  if (
    typeof document === 'undefined' ||
    !document.body ||
    typeof CSS === 'undefined' ||
    !CSS.supports?.('zoom', '2')
  ) {
    return false;
  }
  const outer = document.createElement('div');
  outer.style.cssText =
    'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;zoom:2';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:10px;height:10px';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  const rect = inner.getBoundingClientRect();
  standardZoomSupport = Math.abs(rect.width - 20) < 0.5 && inner.offsetWidth === 10;
  outer.remove();
  return standardZoomSupport;
}

/** Style qui rend une boîte (et son sous-arbre) à `scale`, sans changer sa propre position. */
export function appScaleStyle(scale: number): CSSProperties {
  if (scale === 1) return {};
  if (supportsStandardZoom()) return { zoom: scale };
  return { transform: `scale(${scale})`, transformOrigin: 'top left' };
}

/**
 * Position + échelle d'une surcouche fixe rendue en portail dans <body> (hors
 * du canvas du tableau de bord) qui doit garder la densité du tableau de bord.
 * `top`/`left` sont des px de fenêtre (issus de `getBoundingClientRect`) du
 * coin haut gauche de la surcouche à l'écran ; les tailles propres de la
 * surcouche restent en px logiques.
 *
 * `inScaledLayer` : portail dans un calque déjà rendu à `scale`
 * (`.rv-app-scaled-layer`) ; la surcouche hérite de l'échelle et ses décalages
 * sont en px logiques avec les deux techniques.
 */
export function appScaledOverlayStyle(
  {
    top,
    left,
    scale,
  }: {
    top: number;
    left: number;
    scale: number;
  },
  inScaledLayer = false,
): CSSProperties {
  if (scale === 1) return { top, left };
  if (inScaledLayer) return { top: top / scale, left: left / scale };
  // Les décalages propres d'une boîte zoomée sont zoomés aussi : on les exprime en px logiques.
  if (supportsStandardZoom()) return { top: top / scale, left: left / scale, zoom: scale };
  return { top, left, transform: `scale(${scale})`, transformOrigin: 'top left' };
}

/** `--app-scale` lu sur `el` (hérité du canvas ou de :root), 1 en son absence. */
export function readAppScale(el: Element | null): number {
  if (!el || typeof window === 'undefined') return 1;
  const raw = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--app-scale'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** `--app-scale` currently published on :root (see `publishRootAppScale`). */
export function readRootAppScale(): number {
  if (typeof document === 'undefined') return 1;
  return readAppScale(document.documentElement);
}

/**
 * Publie `scale` comme `--app-scale` sur :root, avec `data-rv-scale-mode`
 * (`zoom` | `transform`) pour que les calques mis à l'échelle en CSS
 * (`.rv-app-scaled-layer`, src/index.css) utilisent la même technique que ceux
 * en JS. Renvoie une fonction de nettoyage.
 */
export function publishRootAppScale(scale: number): () => void {
  const root = document.documentElement;
  root.style.setProperty('--app-scale', String(scale));
  root.dataset.rvScaleMode = supportsStandardZoom() ? 'zoom' : 'transform';
  return () => {
    root.style.removeProperty('--app-scale');
    delete root.dataset.rvScaleMode;
  };
}

/**
 * Garde `--app-scale` sur :root synchronisé avec `computeAppScale(window)`.
 * Pour les pages sans le canvas du tableau de bord (visualiseur LiDAR), dont
 * les panneaux flottants l'appliquent avec `zoom: var(--app-scale)`. Renvoie
 * une fonction de nettoyage.
 */
export function syncRootAppScale(): () => void {
  let cleanup = publishRootAppScale(computeAppScale(readAppScaleViewport()));
  const apply = () => {
    cleanup();
    cleanup = publishRootAppScale(computeAppScale(readAppScaleViewport()));
  };
  const stopWatching = watchAppScaleViewport(apply);
  return () => {
    stopWatching();
    cleanup();
  };
}
