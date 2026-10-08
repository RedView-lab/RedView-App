// ---------------------------------------------------------------------------
// Norvège — MNT national à 1 m via le WCS de Kartverket / Geonorge
// ---------------------------------------------------------------------------
// Sources officielles confirmées pendant l'intégration :
//   * points d'accès WCS NHM DTM en EUREF89 / UTM 32, 33 et 35
//   * couverture nationale, données ouvertes, résolution de 1 m ou plus
//     grossière selon l'échelle demandée
//   * ImageServer WCS 1.0.0/1.1.x/2.0.1 — on utilise 1.0.0, car un GetCoverage
//     piloté par width/height est le contrat stable le plus simple pour des
//     tuiles Mercator.
// ---------------------------------------------------------------------------

const NORWAY_BOUNDS = [2.0, 57.0, 33.4, 72.2];
const NORWAY_DEM_MINZOOM = 10;
const NORWAY_ENGAGE_MPP = 75;
const NORWAY_WCS_VERSION = '1.0.0';
// Le backend à froid (`hoydedata.no`) peut mettre 15 à 25 s à rendre une tuile
// neuve ; 30 s évitent des tempêtes d'abandons et de nouvelles tentatives quand
// on se déplace vers une nouvelle région.
const NORWAY_FETCH_TIMEOUT_MS = 30_000;
// Concurrence portée de 12 à 20 (passe de performance du 6 mai) : l'ImageServer
// ArcGIS de hoydedata.no multiplexe sans peine 20+ flux HTTP/2 par origine, et 12
// étranglait la rafale à l'entrée en Norvège depuis un dézoom satellite (~25
// tuiles en un déplacement de 600 ms). La file passée de 240 à 400 évite
// l'élagage en tête de la vue d'origine une fois le déplacement terminé.
const NORWAY_CONCURRENCY = 20;
const NORWAY_QUEUE_MAX = 400;
const NORWAY_WCS_FORMAT = 'GeoTIFF';
// Taille du raster côté serveur — on demande un suréchantillonnage 2× du pas de
// la tuile de sortie, pour que la reprojection locale UTM→Mercator puisse faire
// une moyenne par blocs pondérée par la surface (≈ 4 pixels source par pixel de
// destination) plutôt qu'un bilinéaire ponctuel. L'échantillonnage ponctuel d'un
// raster UTM demandé au même pas que la sortie Mercator produisait des
// artefacts réguliers de grille / moiré sur l'overlay des pentes (bandes
// obliques visibles sur un terrain lisse) — même mécanisme d'échec que le
// problème du WMS France 0,40 m → 1 m du 3 mai. 4× la bande passante (~520 Ko →
// 4× = ~2 Mo par tuile norvégienne de GeoTIFF float32), mais la Norvège est
// déjà réservée aux zooms élevés et, sur fibre, c'est imperceptible.
const NORWAY_WCS_OUTPUT_PX = 512;

const NORWAY_WCS_ZONES = {
  32: {
    zone: 32,
    epsg: '25832',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25832/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25832',
  },
  33: {
    zone: 33,
    epsg: '25833',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25833/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25833',
  },
  35: {
    zone: 35,
    epsg: '25835',
    base: 'https://hoydedata.no/arcgis/services/NHM_DTM_25835/ImageServer/WCSServer',
    coverage: 'nhm_dtm_topo_25835',
  },
};

function shouldUseNorway(mercZ, lat) {
  if (mercZ < NORWAY_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < NORWAY_ENGAGE_MPP;
}