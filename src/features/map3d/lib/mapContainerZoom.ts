import mapboxgl from 'mapbox-gl';
import { supportsStandardZoom } from '@/shared/lib/appScale';

/**
 * Mapbox GL dimensionné pour un conteneur sous un ancêtre en `zoom` CSS.
 *
 * Le dashboard est rendu à `appScale` avec le `zoom` CSS (`appScaleStyle`,
 * shared/lib/appScale.ts) : 0,85 à 0,95 sur les portables Retina, jusqu'à 1,12
 * sur les grands écrans. Mapbox GL (`Map#_updateContainerDimensions`, vérifié
 * sur 3.21) mesure son conteneur avec `getBoundingClientRect()` — des px zoomés
 * avec le modèle `zoom` standardisé — et ne compense qu'une échelle de
 * `transform` CSS. La transformation et le canvas prenaient alors la taille
 * zoomée, et le canvas était placé dans la boîte zoomée, donc zoomé deux fois :
 * à 0,894 (MacBook Pro 14") la carte 3D couvrait 0,894² de sa surface, avec une
 * bande vide le long des bords droit et bas ; à 1,117 (1440p) elle débordait et
 * était rognée.
 *
 * Le correctif divise cette mesure par le zoom effectif du conteneur : la
 * transformation, la taille CSS du canvas et la correspondance du pointeur
 * (`mousePos` : offsetWidth / rect.width, voir lib/mapPointer.ts) utilisent de
 * nouveau les px de mise en page du conteneur, comme à l'échelle 1, pour que
 * `map.project()`, `event.point`, les marqueurs et les popups correspondent au
 * canvas logique dans lequel l'interface est disposée. Le tampon garde sa
 * densité d'écran : `devicePixelRatio` porte déjà l'échelle du canvas
 * (`setDprLayoutScale`, runtimeProfile.ts).
 *
 * Les moteurs sans `zoom` standardisé reçoivent plutôt un canvas en
 * `transform: scale()` (`appScaleStyle`), que Mapbox compense lui-même : facteur 1.
 */

interface MapContainerInternals {
  _container?: HTMLElement;
  _containerWidth: number;
  _containerHeight: number;
  _updateContainerDimensions?: () => void;
}

/** Produit du `zoom` CSS appliqué à `element` et à ses ancêtres. */
function readEffectiveCssZoom(element: Element): number {
  const native = (element as Element & { currentCSSZoom?: unknown }).currentCSSZoom;
  if (typeof native === 'number') return Number.isFinite(native) && native > 0 ? native : 1;
  let zoom = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = Number.parseFloat(window.getComputedStyle(node).zoom);
    if (Number.isFinite(value) && value > 0) zoom *= value;
  }
  return zoom;
}

let installed = false;

/** Corrige `mapboxgl.Map` une seule fois ; à appeler avant de créer une carte. */
export function installCssZoomAwareMapSizing(): void {
  if (installed) return;
  installed = true;
  const proto = mapboxgl.Map.prototype as unknown as MapContainerInternals;
  const measure = proto._updateContainerDimensions;
  if (typeof measure !== 'function') {
    console.warn('[map3d] Map#_updateContainerDimensions not found: map size under the canvas CSS zoom is not compensated');
    return;
  }
  proto._updateContainerDimensions = function updateContainerDimensions(this: MapContainerInternals) {
    measure.call(this);
    const container = this._container;
    if (!container || !supportsStandardZoom()) return;
    const zoom = readEffectiveCssZoom(container);
    if (zoom === 1) return;
    this._containerWidth = toLayoutPx(this._containerWidth, zoom);
    this._containerHeight = toLayoutPx(this._containerHeight, zoom);
  };
}

/**
 * Le zoom est stocké en float32 (0,89 → 0,88999999) : 890 / zoom donne
 * 1000,000016, que Mapbox arrondit au supérieur en une ligne de tampon de
 * 1001 px pour un canvas de 1000 px — un rééchantillonnage de 0,1 % de toute
 * l'image. De toute façon, les tailles de mise en page sont des multiples de 1/64 px.
 */
function toLayoutPx(zoomedPx: number, zoom: number): number {
  return Math.round((zoomedPx / zoom) * 1000) / 1000;
}
