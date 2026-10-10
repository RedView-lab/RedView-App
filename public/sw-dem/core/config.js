// ---------------------------------------------------------------------------
// Constantes de configuration — partagées par tous les modules du SW
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
const IGN_WMS_BASE = 'https://data.geopf.fr/wms-r/wms';
// MNS LiDAR HD (Modèle Numérique de Surface — sommet de la canopée, arbres,
// rochers et bâtiments compris). C'est ce qui donne à l'utilisateur le relief
// « détail 20 cm avec rochers et arbres » qu'il veut voir. La grille native du
// LiDAR HD est d'environ 1 m, publiée jusqu'à z17 sur le TileMatrixSet WGS84G_4_17.
//
// Le décalage de canopée MNS↔MNT, qui créait des falaises aux jointures où les
// tuiles IGN rencontraient le Terrain-RGB de Mapbox (sol nu), est traité par la
// correction de biais médian de compositeIGNMapbox (composite.js) : le décalage
// de l'anneau de bordure de 1 px est mesuré contre Mapbox, la médiane est
// soustraite comme une constante, et la surface MNS se raccorde à Mapbox à la
// jointure sans marche visible.
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

// MNS LiDAR HD — vrai modèle de surface LiDAR à ~0,40 m, servi par le WMS pour
// qu'une tuile Mercator entière coûte UNE requête au lieu des 20 à 63 sous-tuiles
// WMTS. La requête DOIT rester carrée en mètres (WIDTH = HEIGHT / cos(lat)) ;
// voir mnsWmsRequestSize() dans sources/ign-wms-raster.js pour le défaut mesuré
// de duplication de lignes (1 - cos(lat)) que provoque une requête carrée en degrés.
const IGN_LIDAR_MNS_LAYER = 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

// MNT LiDAR HD — pendant sol nu du MNS ci-dessus (grille de 0,5 m), source
// principale du profil de terrain à 1 m. RGE ALTI (IGN_DEM_FALLBACK_LAYER) n'est
// qu'une grille d'environ 5 m en montagne : à z16 le WMS renvoie 92 lignes et
// 128 colonnes distinctes pour une requête de 512×725, soit un escalier étiré
// 4× que Horn transforme en hachures denses. RGE ALTI ne remplit plus que les
// pixels que le MNT LiDAR ne couvre pas encore.
const IGN_LIDAR_MNT_LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G';

// Repli MNS de corrélation — volontairement NON utilisé comme repli WMS.
// Mesuré en EPSG:4326 ET en EPSG:3857 : seule la moitié des lignes demandées
// sont distinctes (128/256), les lignes dupliquées ne sont pas alignées par
// paires, et le peigne pair/impair du gradient reste entre 0,70 et 1,23 quelle
// que soit la géométrie de la requête. Donner ce raster à Horn recrée l'artefact
// en tirets sur l'overlay des pentes : getMnsWmsTile() renvoie donc null et
// laisse buildIGNTile passer par le chemin WMTS (matrice de tuiles WGS84G
// native, sans rééchantillonnage des lignes).
const IGN_MNS_CORREL_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';

// Modèle de terrain RGE ALTI (MNT / sol nu). L'IGN publie officiellement ce
// jeu de données à 1 m et 5 m de résolution ; le point d'accès WMTS ci-dessous
// expose le même produit sur une grille de tuiles plus grossière, tandis que le
// WMS peut servir directement un raster 32 bits pour une bbox quelconque.
const IGN_DEM_FALLBACK_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const IGN_DEM_FALLBACK_TILEMATRIXSET = 'WGS84G_6_14';
const IGN_DEM_FALLBACK_MINZOOM = 6;
const IGN_DEM_FALLBACK_MAXZOOM = 14;

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];

// Territoires français d'outre-mer (DOM-TOM) où l'IGN publie la même pyramide
// LiDAR HIGHRES / HIGHRES.MNS sur le TileMatrixSet mondial WGS84G.
// Chaque entrée est [ouest, sud, est, nord] en lng/lat. Les tuiles situées dans
// l'une de ces bbox sont traitées par le dispatcher comme des tuiles
// « majoritairement en France » (branches CH/NO/ES sautées, test du polygone
// france-border.json — métropole seulement — sauté, passage direct au chemin IGN HD).
//
// Couverture (vérifiée sur la Géoplateforme) :
//   - REU (La Réunion)      : LiDAR HD publié en 2023-2024, île entière
//   - GLP (Guadeloupe)      : LiDAR HD publié, archipel entier
//   - MTQ (Martinique)      : LiDAR HD publié, île entière
//   - MYT (Mayotte)         : LiDAR HD publié, île entière
//   - GUF (Guyane française): RGE ALTI 5 m + LiDAR HD partiel
const OVERSEAS_FRANCE_BOUNDS = [
  [55.20, -21.40, 55.85, -20.85], // Réunion
  [-61.85, 15.80, -61.00, 16.55], // Guadeloupe
  [-61.25, 14.35, -60.80, 14.90], // Martinique
  [45.00, -13.05, 45.30, -12.60], // Mayotte
  [-54.65, 2.10, -51.60, 5.80],   // Guyane française
];

const DEM_TILE_SIZE = 256;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;

// Bornes physiques d'altitude servant à rejeter les valeurs sentinelles (l'IGN
// sert parfois -9999.0 comme nodata au lieu du -99999 documenté). Le point réel
// le plus bas de France est à ~-5 m (delta du Rhône) : toute valeur sous -500 m
// est une sentinelle ; toute valeur au-dessus de 9 000 m est impossible (le Mont
// Blanc culmine à 4 810 m) et vient de pixels chauds LiDAR / d'artefacts du
// scanner. Les valeurs hors de cet intervalle sont traitées exactement comme NaN.
const MIN_VALID_ELEVATION_M = -500;
const MAX_VALID_ELEVATION_M = 9_000;

// Seuil de despike — si un pixel s'écarte de plus de ce nombre de mètres de la
// médiane de son voisinage 3×3, il est ramené à la médiane. Rattrape les pixels
// chauds LiDAR isolés qui ont survécu au prétraitement de l'IGN, sans effacer
// les vraies crêtes (une vraie falaise s'étend sur plusieurs pixels).
const DESPIKE_THRESHOLD_M = 80;

const IGN_DEM_MINZOOM = 11;
const IGN_DEM_MAXZOOM = 17;

// Seuils d'activation de la HD France (z >= 11).
const IGN_HIGHRES_ENGAGE_MPP = 80;
const IGN_MNS_ENGAGE_MPP = 80;
const IGN_TERRAIN_WMS_ENGAGE_MPP = 80;

// Quand l'utilisateur choisit le mode surface 0,40 m, il attend un vrai relief
// de surface (maisons, rangées d'arbres, murs), pas seulement la bonne famille
// de données. Avec `demZ = mercZ`, le MNS reste actif mais il est souvent
// échantillonné trop grossièrement aux zooms intermédiaires obliques : les
// éléments urbains se fondent alors dans quelque chose qui ressemble à du sol
// nu. Un léger biais de zoom source alimente le maillage avec des tuiles MNS
// plus fines avant d'atteindre la plage rapprochée native z16/z17.
//
// Passe multicœur du 2026-06-20 : le biais dépend désormais du ZOOM. Le
// TileMatrixSet WGS84G est 2× plus large que haut, donc chaque +1 de biais
// QUADRUPLE à peu près le nombre de sous-tuiles. À z14, biais=2 → demZ 16 →
// 63 sous-tuiles (9×7) ; à froid, chacune est un fetch IGN distinct qui répond
// 404 dans les zones sans MNS, consomme le délai souple de 5 s et bloque le fil
// du SW (le symptôme « la carte gèle quand les pentes sont actives »). À z14, un
// pixel d'écran fait déjà ~9 m : échantillonner z16 (≈2,5 m) est excessif —
// biais=1 (z15, ≈5 m, 20 sous-tuiles) donne le même détail de surface visible
// pour un tiers des sous-tuiles. Le biais complet de 2 n'est gardé qu'à partir
// de z15, quand l'utilisateur est assez près pour voir ce détail ET qu'une
// tuile couvre une emprise au sol plus petite, donc des sous-tuiles plus
// probablement toutes couvertes par le MNS (pas de 404).
function ignMnsSourceZoomBias(mercZ) {
  // À partir de z16, demZ=16 en WGS84G donne déjà 0,84 m/px aux latitudes de la
  // France, plus fin que la grille native d'environ 1 m du MNS LiDAR de l'IGN. Un
  // biais de 0 évite l'explosion quadratique en 20-30 sous-tuiles avec le détail complet.
  if (mercZ >= 16) return 0;
  // De z13 à z15, biais=1 donne ~1,7 m de résolution avec 4 à 8 sous-tuiles au lieu de 20+.
  if (mercZ >= 13) return 1;
  return 0;
}

// Lissage du MNS France aux zooms intermédiaires. Le MNS de l'IGN garde le
// sommet de la canopée et les bâtiments, ce que veut l'utilisateur, mais la
// surface rééchantillonnée peut montrer un motif régulier de « micro-ondulation »
// en vue oblique vers z11-z13. On applique une moyenne pondérée 3x3 très légère,
// seulement sur les voisinages de faible variance locale : les grandes pentes
// sont lissées, les falaises, crêtes et arêtes rocheuses restent nettes.
const IGN_MNS_MIDZOOM_SMOOTH_MAXZOOM = 13;
const IGN_MNS_MIDZOOM_SMOOTH_VARIANCE_M = 5;

function mercatorMetersPerPixel(mercZ, lat) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Circonférence de la Terre à l'équateur, en mètres
  return (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
}

function shouldUseIGNHighres(mercZ, lat) {
  if (mercZ < IGN_DEM_FALLBACK_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < IGN_HIGHRES_ENGAGE_MPP;
}

function shouldUseIGN(mercZ, lat) {
  if (mercZ < IGN_DEM_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < IGN_MNS_ENGAGE_MPP;
}

function shouldUseIGNTerrainWms(mercZ, lat) {
  if (mercZ < IGN_DEM_FALLBACK_MINZOOM) return false;
  return mercatorMetersPerPixel(mercZ, lat) < IGN_TERRAIN_WMS_ENGAGE_MPP;
}

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

// Époque globale des caches de carte. Changer ce seul jeton quand une version
// doit forcer la remise à zéro complète des caches DEM / ortho / pente /
// altitude / carte de projet chez tous les clients. L'app propage la même
// époque dans les URL de requêtes DEM et dans des purges ponctuelles côté navigateur.
//
// 2026-05-08-satellite-dem-refresh-3 : garde les bordures de pente calculées
// avec les voisines en mode terrain 1 m et force le rafraîchissement /
// la récupération du DEM Standard-Satellite pour purger les tuiles plates
// périmées de la pyramide raster-dem de Mapbox.
//
// 2026-05-08-slope-1m-fast-quality-1 : livre la mise à jour du pipeline de
// pente à 1 m (préchargement du profil terrain, LRU des DEM décodés, réparation
// différée des jointures avec les voisines, correctif du rechargement des caches
// dérivés). Changer l'époque ici garantit que les sous-modules sw-dem sont
// rechargés avec une nouvelle query string et que les entrées pente/DEM
// périmées sont purgées une fois.
//
// 2026-05-28-france-mns-source-zoom-bias-1 : garde la surface MNS France active
// et demande un zoom source un peu plus fin que le zoom d'écran, pour que le
// relief urbain et de canopée reste visible en mode 0,40 m en zoom oblique moyen.
// 2026-05-28-terrain-1m-midzoom-ripple-fix-1 : retarde le passage au WMS du
// profil terrain France jusqu'à ~22 m/px, pour que les vues obliques z11-z12
// restent sur le repli sol nu plus lisse au lieu de montrer les ondulations de
// reprojection à 1 m.
// 2026-05-30-france-lod-datum-wall-fix-1 : supprime le biais de datum Mapbox par
// tuile sur les tuiles intérieures de France entièrement couvertes, pour que des
// tuiles voisines rendues à des LOD différents ne soient plus décalées de
// quelques mètres (« murs » verticaux en 0,40 m).
//
// 2026-06-20-slope-multicore-pool-2 : pool de workers dédié aux constructions de
// pente (Horn + décodage + encodage PNG hors du fil du SW), niveau mémoire
// SLOPE_HOT_CACHE (sur le modèle de DEM_HOT_CACHE), préchauffage croisé entre
// profils. Corrige aussi le gel du fond de carte au zoom : (a) abandon précoce
// de build-tile quand les 8 premières sous-tuiles échouent toutes (on attendait
// tout le délai de 5 s pour 63 réponses 404) ; (b) biais de source MNS selon le
// zoom (z14 partait sur 63 sous-tuiles au lieu de 20) ; (c) délais souples
// réduits ; (d) CANCEL_STALE_DEM vide désormais DEM_INFLIGHT, pour que les
// requêtes de la nouvelle vue ne se greffent pas sur des constructions périmées.
//
// 2026-06-21-slope-decode-in-worker-1 : le décodage du DEM (createImageBitmap +
// getImageData + boucle Float32) passe DANS le worker — le SW ne fait plus que
// la lecture CacheStorage et le transfert. L'encodeur PNG utilise le filtre Sub
// (deflate ~3× plus rapide et PNG plus petits sur les gradients de pente lisses).
//
// 2026-06-29-altitude-decode-in-worker-1 : l'overlay d'altitude rejoint le pool
// de workers des pentes — son décodage, son encodage RGBA et son encodage PNG
// tournent désormais HORS du fil du SW (envoi kind:'altitude'). Avant, l'altitude
// était calculée entièrement sur le fil du SW avec ALTITUDE_BUILD_MAX_CONCURRENT=2, le principal
//
// 2026-10-01-slope-lidar-wms-v2 : les rasters WMS LiDAR HD sont demandés en 2×
// puis moyennés par blocs (anti-crénelage), le profil terrain à 1 m lit le MNT
// LiDAR HD au lieu de RGE ALTI, et les backends geopf instables (400
// LayerNotDefined, 429) sont réessayés au lieu de retomber sur des données à
// 30 m. Toutes les tuiles DEM/pente en cache avaient été construites à partir
// des rasters crénelés, d'où la purge complète.
//
// 2026-10-01-surface-standin-1 : un échec passager du MNS 0,40 m (délai WMS
// dépassé, abandon CANCEL_STALE_DEM au zoomstart) mettait en cache le repli MNT
// sol nu comme réponse définitive de la tuile — les bâtiments disparaissaient au
// zoom avant. Ces remplaçants sont désormais mis en cache brièvement puis
// récupérés depuis le MNS ; la purge supprime les tuiles sol nu déjà en cache
// sous le profil surface.
//
// 2026-10-02-gesture-cancel-1 : chaque geste de caméra (rotation, inclinaison,
// déplacement) annulait les fetchs LiDAR HD des tuiles encore à l'écran ; la
// construction retombait alors sur le MNS de corrélation / le préremplissage à
// 30 m et le gardait en cache, si bien que le relief tombait à ~30 m rien qu'en
// tournant la caméra. Les gestes ne touchent plus au travail des tuiles
// visibles ; la purge supprime les tuiles dégradées.
const MAP_CACHE_EPOCH = '2026-10-02-gesture-cancel-1';

// ── Réglages du pipeline de pente (passe multicœur du 2026-06-20) ──────
// Taille du pool de workers dédié aux pentes. On réserve un cœur au fil du SW
// (réseau + cache + ordonnanceur IGN) et on plafonne à 8 pour que les machines
// très denses (stations HEDT à 16/32 cœurs) ne créent pas trop de workers, dont
// le coût des échanges de messages dépasserait le gain CPU par tuile.
const SLOPE_POOL_MAX_WORKERS = 16;
const SLOPE_POOL_MIN_WORKERS = 2;

// SLOPE_HOT_CACHE — LRU en mémoire des PNG de pente servis récemment, sur le
// modèle de DEM_HOT_CACHE. Les tuiles de pente alignées sur le terrain font 512²
// et sont 16× moins nombreuses que les anciennes tuiles 256² à z+2 : 384 entrées
// couvrent plusieurs vues.
const SLOPE_HOT_CACHE_MAX = 384;

// ALTITUDE_HOT_CACHE — LRU en mémoire des PNG d'altitude servis récemment, sur
// le modèle de SLOPE_HOT_CACHE.
const ALTITUDE_HOT_CACHE_MAX = 2048;

// Quand l'utilisateur active les pentes ou l'altitude, on agrandit le niveau
// mémoire des DEM pour qu'un déplacement en zoom très éloigné (+400 tuiles)
// n'évince jamais de tuiles de la RAM.
const DEM_HOT_CACHE_MAX_SLOPE_ACTIVE = 2048;

// Raison passée à AbortController.abort() quand CANCEL_STALE_DEM annule un
// fetch IGN/Ortho en cours. Les gestionnaires d'erreur testent
// `controller.signal.reason === USER_CANCEL_REASON` et SAUTENT l'écriture en
// cache négatif pour ces tuiles — une nouvelle demande émise peu après (la
// nouvelle vue recouvre souvent l'ancienne) doit passer par le vrai pipeline,
// pas être court-circuitée par une entrée nulle passagère causée par notre
// propre annulation.
const USER_CANCEL_REASON = 'rv-user-gesture-cancel';

const CACHE_NAME = `dem-tiles-${MAP_CACHE_EPOCH}`;
const NEGATIVE_CACHE_NAME = `dem-negative-${MAP_CACHE_EPOCH}`;
const ORTHO_CACHE_NAME = `ortho-tiles-${MAP_CACHE_EPOCH}`;
// `v2` : purge les tuiles de pente construites sur un DEM suréchantillonné
// (overzoom ou serveur) hors des emprises LiDAR (2026-10-01). `v3` : tuiles
// alignées sur le terrain (mêmes z/x/y que la pyramide DEM 3D), PNG gris+alpha
// en Catmull-Rom 2×. Même préfixe géré : l'activation supprime l'ancien cache
// sans toucher aux caches DEM.
const SLOPE_CACHE_NAME = `slope-tiles-v3-${MAP_CACHE_EPOCH}`;
const ALTITUDE_CACHE_NAME = `altitude-tiles-${MAP_CACHE_EPOCH}`;
// Courbes de niveau vectorielles (MVT), isolignes exactes du maillage du terrain
// (runtime/contour-handler.js).
const CONTOUR_CACHE_NAME = `contour-tiles-v2-${MAP_CACHE_EPOCH}`;
const STATIC_CACHE_NAME = `dem-static-${MAP_CACHE_EPOCH}`;

// Indicateur de debug — conditionne la journalisation détaillée par tuile. Les
// avertissements et erreurs sont toujours journalisés.
// Modifiable à chaud via swLog.setLevel('debug' | 'warn') ou postMessage({ type: 'SET_SW_LOG_LEVEL' })
var DEBUG = false;
function isSwDebug() {
  return typeof swLog !== 'undefined' ? swLog.isDebug() : Boolean(DEBUG);
}

const IGN_CACHE_MAX = 500;
// HTTP/2 sur data.geopf.fr multiplexe sans peine 40+ flux par connexion.
// Au zoom avant, la vue demande ~80 sous-tuiles d'un coup (20 tuiles Mapbox ×
// 4 sous-tuiles WGS84G). Avec une concurrence de 20, la file de 60 allongeait
// le temps de fetch effectif au-delà du délai souple de 1,5 s → les tuiles
// retombaient sur Mapbox suréchantillonné (plat, 30 m) alors que l'IGN
// répondait bien 200.
//
// Passe de performance du 19 mai : adaptée au CPU. Le serveur HTTP/2 de la
// Géoplateforme annonce en général SETTINGS_MAX_CONCURRENT_STREAMS entre 100 et
// 128, et le navigateur les garde tous ouverts tant que le SW a du travail à
// leur donner. Sur 8 cœurs et plus, le fil du SW émet sans peine 56 à 64 fetchs
// simultanés sans saturer la boucle d'événements. Sur les petites machines, on
// garde la valeur historique de 40 pour éviter de saturer l'ordonnancement.
const IGN_CONCURRENCY = (() => {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 4) return 40;
  if (hc >= 12) return 64;
  if (hc >= 8) return 56;
  return 48;
})();
// Dimensionné pour une inclinaison de 60° à z14 sur une vue large — la rafale
// peut dépasser 300 requêtes de tuiles en < 500 ms. En dessous, on commence à
// élaguer, ce qui reste correct mais dégrade le déplacement.
const IGN_QUEUE_MAX = 600;

// Concurrence ortho séparée — l'ortho n'affame pas le DEM, et inversement.
// Passée de 10 à 16 : HTTP/2 sur geopf multiplexe sans peine 20+ flux, et à 10
// la file bloquait la vue en tête de file pendant un dézoom rapide.
//
// 19 mai : adaptée au CPU (même raison que pour IGN_CONCURRENCY ci-dessus). Sur
// 8 cœurs et plus, le pipeline ortho est le plus lent pendant un déplacement
// rapide en mode satellite ; passer à 24 le met au niveau du pipeline DEM, et
// les deux arrivent ensemble au lieu d'une ortho qui apparaît 200 ms plus tard.
const ORTHO_CONCURRENCY = (() => {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 4) return 16;
  if (hc >= 12) return 28;
  if (hc >= 8) return 24;
  return 20;
})();
const ORTHO_QUEUE_MAX = 400;

// Délai de fetch WMTS IGN (ms). La Géoplateforme peut monter à 10 s et plus aux
// heures de pointe ; 15 s évite de mettre en cache à tort une erreur définitive.
const IGN_FETCH_TIMEOUT_MS = 15_000;

// Délai de fetch des orthophotos — plus court que pour le DEM, car une tuile
// ortho bloquée garde le parent flou à l'écran et bloque la file ortho. 8 s
// suffisent pour les JPEG chauds de geopf tout en échouant vite vers le chemin
// d'overzoom du parent.
const ORTHO_FETCH_TIMEOUT_MS = 8_000;

// Si le fetch d'une tuile ortho n'a pas abouti dans ce délai, on donne tout de
// suite au rendu une tuile parente recadrée et le vrai fetch continue en
// arrière-plan. Supprime l'artefact « trou blanc au dézoom » sans annuler de
// travail utile.
const ORTHO_INFLIGHT_PROMOTE_MS = 800;

// TTL du cache nul (ms) — distinguent les erreurs passagères des 404 définitives
const IGN_NULL_TTL_TRANSIENT = 10_000;   // 10s — timeout, 5xx, network error
const IGN_NULL_TTL_PERMANENT = 3600_000; // 1 h — 404, taille invalide

// TTL du cache négatif au niveau de CacheStorage (secondes)
const NEGATIVE_TTL_CONFIRMED = 3600;     // 1 h — la tuile n'existe vraiment pas
const NEGATIVE_TTL_PIPELINE = 2;         // 2s  — transient France pipeline failure; retry fast

// Objet sentinelle renvoyé par l'élagage de la file — ne jamais mettre en cache ces échecs
const PRUNED_SENTINEL = Object.freeze({ _pruned: true });

// Réponse des fetchers de raster IGN (getMnsWmsTile, getTerrainWmsTile) quand
// leur requête a été annulée ou élaguée — vidage sur geste, élagage d'une tuile
// périmée (DEM_WANTED_TILES) — au lieu d'aboutir. Ce n'est jamais un verdict de
// couverture : les constructeurs réessaient tant que la tuile est encore
// voulue, sinon ils abandonnent sans enregistrer de tuile de repli
// (fetchIgnRasterThroughCancels).
const IGN_FETCH_CANCELLED = Object.freeze({ _cancelled: true });

// Nombre maximal de niveaux de zoom de repli quand la tuile IGN manque
const IGN_FALLBACK_MAX_DEPTH = 3;
// Nombre maximal de niveaux d'overzoom du DEM quand la tuile native manque
const DEM_OVERZOOM_MAX_DEPTH = 4;

// Délai souple adapté au zoom. Près du terrain, l'utilisateur attend le détail
// du LiDAR HD — PAS un repli Mapbox à 30 m. Le délai est le temps maximal que
// le pipeline attend toutes les sous-tuiles IGN avant de composer avec ce qu'il
// a ; on laisse volontairement les retardataires dominer le budget de temps aux
// zooms élevés, parce que :
//   1. le Terrain-RGB de Mapbox à z≥14 est suréchantillonné côté serveur (plat) :
//      y retomber dégrade franchement le rendu ;
//   2. les fetchs de sous-tuiles IGN sont mis en cache et dédupliqués en
//      mémoire : l'utilisateur paie une fois par tuile, puis chaque rendu est
//      instantané ;
//   3. à z≥16, le préremplissage Mapbox cache le vrai détail rocheux sous un
//      flou bilinéaire à 30 m — pire qu'un bref temps de chargement.
//
// Délais :
//   * z≤12 : 1,2 s — vue d'ensemble, Mapbox suffit (l'IGN n'est pas sollicité).
//   * z=13 : 2,5 s — l'IGN entre en jeu, compromis entre attente et couverture.
//   * z=14 : 5,0 s — premier zoom LiDAR, le détail est nécessaire.
//   * z=15 : 9,0 s — vue rapprochée ; le LiDAR est essentiel, Mapbox est plat.
//   * z≥16 : 14,0 s — sommets / détail rocheux ; attendre plus longtemps vaut
//     toujours mieux que servir Mapbox à 30 m. Sur Mac / liaisons plus lentes,
//     les 8 s d'origine étaient assez courtes pour que des sommets type Mont
//     Blanc dépassent systématiquement le délai → composition avec une
//     couverture partielle → baisse de qualité visible.
function ignSoftDeadlineMs(mercZ) {
  if (mercZ <= 12) return 1_200;
  if (mercZ === 13) return 2_000;
  if (mercZ === 14) return 3_000;
  if (mercZ === 15) return 6_000;
  return 10_000;
}
const IGN_SUBTILE_SOFT_DEADLINE_MS = 14_000; // constante de repli / héritée
