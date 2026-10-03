import type { DetectedCrs } from '../types';

/**
 * Orthophotos Web Mercator (grille 3857 standard, CORS ouvert) des Pays-Bas et
 * de la Flandre, pour la colorisation des nuages sans RVB et la texture sol du
 * viewer WebGL. Les sous-dalles AHN de GeoTiles portent déjà leur couleur.
 *
 *  - Pays-Bas : PDOK Luchtfoto RGB « Actueel_orthoHR » (8 cm, JPEG).
 *  - Flandre : Digitaal Vlaanderen, orthophoto moyenne échelle la plus
 *    récente (OMWRGBMRVL, PNG uniquement).
 */
export function beneluxOrthoTileUrl(crs: DetectedCrs, z: number, x: number, y: number): string | null {
  if (crs === 'RD_NEW') {
    return `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/${z}/${x}/${y}.jpeg`;
  }
  if (crs === 'BL72') {
    return 'https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
      + `&LAYER=omwrgbmrvl&STYLE=&FORMAT=image/png&TILEMATRIXSET=GoogleMapsVL&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  }
  return null;
}
