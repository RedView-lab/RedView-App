import { VHR_ORTHO_SOURCE_ID } from './sources';

// Overlay d'orthophoto IGN. Utilise l'emplacement par défaut de Standard-Satellite
// (middle) pour que l'imagerie IGN à 20 cm s'affiche AU-DESSUS du satellite de
// base, pas en dessous. 'slot: "bottom"' cache entièrement le calque sous
// Standard-Satellite.
export const ignOrthoLayer = {
  id: 'ign-ortho-layer',
  type: 'raster' as const,
  source: 'ign-ortho',
  slot: 'top',
  minzoom: 11,
  paint: {
    'raster-opacity': 1,
    // Fondu enchaîné de la tuile parente vers l'enfant sur 250 ms. Avec 0 ms
    // (réglage précédent), un fetch de tuile en attente laissait un trou blanc
    // instantané ; avec 250 ms, Mapbox GL garde visible le parent flou mais valide
    // jusqu'à l'arrivée de l'enfant net, ce qui supprime l'artefact de dézoom
    // « patchwork de tuiles manquantes » sans perte de netteté perceptible.
    'raster-fade-duration': 250,
    // Agrandissement bilinéaire lissé du parent suréchantillonné pendant que le
    // fetch de l'enfant est en attente — évite la pixelisation pendant le fondu.
    'raster-resampling': 'linear' as const,
  },
  layout: {
    visibility: 'visible' as const,
  },
};

// Ortho à très haute résolution (voir `buildVhrOrthoSource`). Insérée juste
// au-dessus du raster satellite de Mapbox, sous les routes, les libellés et
// chaque overlay de l'app.
export const vhrOrthoLayer = {
  id: 'rv-vhr-ortho-layer',
  type: 'raster' as const,
  source: VHR_ORTHO_SOURCE_ID,
  // Une source de 256 px demande round(zoom + 1) : ses tuiles z18 commencent au zoom 16,5.
  minzoom: 16.5,
  paint: {
    'raster-opacity': 1,
    'raster-fade-duration': 200,
    'raster-resampling': 'linear' as const,
  },
};
