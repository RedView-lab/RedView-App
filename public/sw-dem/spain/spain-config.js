// ---------------------------------------------------------------------------
// Espagne — MDT national via le WCS INSPIRE de l'IGN / IDEE
// ---------------------------------------------------------------------------
// Points d'accès officiels validés pendant l'intégration :
//   * WCS : https://servicios.idee.es/wcs-inspire/mdt?service=WCS&request=GetCapabilities
//   * Référence WMS ortho : https://www.ign.es/wms-inspire/pnoa-ma?service=WMS&request=GetCapabilities
//
// Constats :
//   * Le service DEM national expose des produits à 1000 / 500 / 200 / 25 / 5 m.
//   * Le meilleur raster de terrain national disponible via le WCS officiel est à 5 m.
//   * La couverture native continent / Baléares est Elevacion25830_5 (EPSG:25830).
//   * La couverture native des Canaries est Elevacion4083_5 (EPSG:4083 / REGCAN95 UTM28).
//   * Un GetCoverage avec `scaleSize=x(256),y(256)` fait sous-échantillonner le
//     serveur, qui sert un TIFF 16 bits fixe de 256x256 (~131 Ko) avec un cache
//     CloudFront d'un an. Sans cela, une seule tuile z12 transfère ~8 Mo
//     (10 km × 10 km / 5 m → 2000² pixels natifs), ce qui saturait la file de
//     fetch du SW, bloquait la pastille pente / altitude à 1 % et donnait des
//     tuiles plates par intermittence quand la requête expirait avant la fin du
//     téléchargement du corps.
// ---------------------------------------------------------------------------

const SPAIN_BOUNDS = [-19.5, 27.0, 5.5, 44.5];
const SPAIN_MAINLAND_BOUNDS = [-10.5, 35.0, 5.5, 44.5];
const SPAIN_CANARY_BOUNDS = [-19.5, 27.0, -12.0, 30.5];
const SPAIN_DEM_RESOLUTION_M = 5;
const SPAIN_DEM_MINZOOM = 11;
const SPAIN_ENGAGE_MPP = 60;
// Le backend IDEE peut être lent sur les échecs de cache à froid (génération du
// raster côté serveur pour la bbox demandée). 15 s étaient parfois trop courtes
// lors des premières visites d'une nouvelle région — l'abandon se déclenchait,
// le travail était perdu et les tuiles remises en file, ce qui faisait boule de
// neige jusqu'à une impression de « chargement interminable » au premier rendu.
const SPAIN_FETCH_TIMEOUT_MS = 30_000;
// Chaque requête renvoie un TIFF 16 bits fixe servi par un nœud CloudFront avec
// un max-age d'un an. 256² (~131 Ko) était le choix d'origine ; passé à 512²
// (~520 Ko) pour que le raster source corresponde à la grille native de 5 m du
// MDT5 à z14-15 (une tuile espagnole z14 fait ~2,5 km de large → 500² pixels
// natifs : 512² capte pratiquement chaque pixel natif sans sous-échantillonnage
// côté serveur ni les artefacts de passe-bas associés, qui produisaient les
// lignes de « contours ondulés » visibles sur les pentes lisses). 4× plus
// d'octets par tuile, mais sur fibre c'est imperceptible face à la latence d'un
// échec de cache à froid du backend, et CloudFront garde tout en cache un an.
// Concurrence portée de 16 à 24 (passe de performance du 6 mai) : les réponses
// IDEE sont désormais en cache d'un an sur les nœuds CloudFront grâce au
// plafond scaleSize=512, donc le coût réel d'une requête est dominé par l'aller-
// retour, pas par le calcul du backend. HTTP/2 sur servicios.idee.es multiplexe
// sans peine 24+ flux ; 16 provoquait des élagages pendant les déplacements
// rapides sur la vue des Pyrénées (qui peut demander 30+ tuiles espagnoles en
// une rafale quand continent et Canaries se cumulent). La file passée de 400 à
// 600 évite que la tête soit élaguée sous la vue active quand le déplacement
// marque une pause pendant un dézoom.
const SPAIN_CONCURRENCY = 24;
const SPAIN_QUEUE_MAX = 600;
const SPAIN_WCS_OUTPUT_PX = 512;
const SPAIN_WCS_VERSION = '2.0.1';
const SPAIN_WCS_FORMAT = 'image/tiff';
// Le MDT5 stocke les altitudes en Int16 en mètres → quantification verticale de
// 1 m. Sur pentes douces (≤ ~15°), cela apparaît sous forme de courbes en
// « escalier » horizontales de 1 m dans le maillage 3D (« micro-ondulations »).
// Un léger passe-bas 3×3, appliqué seulement là où l'écart d'altitude local 3×3
// est sous ce seuil, lisse la quantification sans adoucir les vraies falaises /
// crêtes.
const SPAIN_SMOOTH_VARIANCE_M = 4;

const SPAIN_WCS_COVERAGES = {
  mainland: {
    key: 'mainland',
    coverageId: 'Elevacion25830_5',
    epsg: '25830',
    utmZone: 30,
  },
  canary: {
    key: 'canary',
    coverageId: 'Elevacion4083_5',
    epsg: '4083',
    utmZone: 28,
  },
};

function shouldUseSpain(mercZ, lat) {
  if (mercZ < SPAIN_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) <= SPAIN_ENGAGE_MPP;
}