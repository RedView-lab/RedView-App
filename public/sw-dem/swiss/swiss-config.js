// ---------------------------------------------------------------------------
// Suisse — constantes de l'intégration swissSURFACE3D Raster
// ---------------------------------------------------------------------------
// Source : swissSURFACE3D Raster (Office fédéral de topographie — swisstopo)
//   — Modèle numérique de surface (sommet de la canopée : arbres, bâtiments, ponts)
//   — Grille de 0,5 m, précision altimétrique de ±10 cm (issu du LiDAR)
//   — Licence : OGD (Open Government Data) — usage commercial autorisé, gratuit
//   — Publié en Cloud Optimized GeoTIFF (COG) sur AWS, indexé par STAC
//
// Points d'accès :
//   Collection STAC :  https://data.geo.admin.ch/api/stac/v1/collections/
//                      ch.swisstopo.swisssurface3d-raster
//   Items (bbox)    :  …/items?bbox={W},{S},{E},{N}&limit=…
//   URL du COG      :  https://data.geo.admin.ch/ch.swisstopo.swisssurface3d-
//                      raster/{itemId}/{itemId}_0.5_2056_{group}.tif
//
// Nommage des items : swisssurface3d-raster_{année}_{Ekm}-{Nkm}
//   Ekm, Nkm = floor(est_LV95/1000), floor(nord_LV95/1000) — le coin sud-ouest
//   de la tuile de 1 km². L'année est publiée par vague d'acquisition
//   (actuellement 2018-2024 selon les régions) ; on résout l'année de chaque
//   cellule via STAC, car elle n'est pas déterministe.
// ---------------------------------------------------------------------------

const SWISS_STAC_BASE =
  'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items';

// Emprise WGS84 prudente de la Suisse (Liechtenstein compris).
// Tirée de l'étendue de la collection STAC : [5.95, 45.81, 10.50, 47.82].
// Légèrement élargie pour que les tuiles de bord déclenchent encore le
// classement en Suisse.
const SWITZERLAND_BOUNDS = [5.90, 45.78, 10.55, 47.85];

// Étendue LV95 (EPSG:2056) des données swissSURFACE3D Raster officiellement
// publiées — sert de rejet rapide préalable pour les tuiles qui tombent dans la
// bbox Mercator de la Suisse mais hors de la zone levée (p. ex. la bbox mord
// sur la Haute-Savoie française ou le Val d'Aoste italien).
//   E ∈ [2 485 000, 2 834 000]  (≈ 349 km de large)
//   N ∈ [1 075 000, 1 296 000]  (≈ 221 km de haut)
const SWISS_LV95_BOUNDS = {
  Emin: 2_485_000,
  Emax: 2_834_000,
  Nmin: 1_075_000,
  Nmax: 1_296_000,
};

// Résolution native de la source
const SWISS_NATIVE_GSD = 0.5;       // mètres par pixel
const SWISS_KM_TILE_PX = 2000;      // 1 km / 0,5 m = 2000 pixels
const SWISS_KM_TILE_M = 1000;       // taille d'une tuile de 1 km, en mètres

// Seuil de zoom Mercator.
//
// Même avec la pyramide TIFF (aperçus à 1 m / 2 m / 4 m / 8 m / 16 m), le coût
// de *découverte* par cellule demeure : chaque cellule LV95 de 1 km demande une
// résolution STAC et une ouverture d'en-tête COG. Une tuile Mercator z=11 couvre
// ~20×20 km = ~400 cellules → 400 requêtes STAC (regroupées en ~16 appels de
// bbox de 5×5, soit encore 16 allers-retours) + ~400 fetchs d'en-têtes. C'est ce
// qui a fait exploser la file le 24 avril avant même le fetch par pixel. On
// garde donc z=12 comme plancher (une tuile z=12 fait ~10×10 = ~100 cellules,
// à peu près ce que SWISS_CONCURRENCY=16 peut tenir en quelques secondes).
//
// Dans cette plage, pickSwissCOGLevel() lit l'aperçu correspondant au lieu du
// natif à 0,5 m : une tuile z=12 se résout depuis L4 (8 m) et ne demande
// qu'environ 1 tuile interne par cellule.
const SWISS_ENGAGE_MPP = 40;
function shouldUseSwiss(mercZ, lat) {
  if (mercZ < SWISS_DEM_MINZOOM) return false;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const mppAtZ = (40075016.686 * Math.abs(cosLat)) / (256 * (1 << mercZ));
  return mppAtZ < SWISS_ENGAGE_MPP;
}

// Délais HTTP — réglés pour les requêtes de plages de COG hébergés sur AWS. En
// charge de pointe (16 tuiles Mercator × 4 à 9 sous-cellules = 100+ fetchs de
// plages simultanés), data.geo.admin.ch peut mettre 10 à 20 s par réponse. STAC
// porté à 15 s, plages COG à 20 s avec une nouvelle tentative automatique en cas
// de délai dépassé (observations du 24 avril).
const SWISS_STAC_FETCH_TIMEOUT_MS = 15_000;
const SWISS_COG_HEADER_TIMEOUT_MS = 12_000;
const SWISS_COG_RANGE_TIMEOUT_MS  = 20_000;
const SWISS_COG_RANGE_RETRIES     = 2;   // nombre total d'essais, premier compris
const SWISS_COG_HEADER_RETRIES    = 3;   // les en-têtes sont minuscules → nouvelle tentative peu coûteuse

// TTL du cache négatif (ms) — les échecs STAC sont en général définitifs (tuile
// non levée) : on les garde une heure. Les échecs passagers de plages /
// d'en-têtes ne doivent PAS empoisonner le cache longtemps : l'utilisateur se
// déplace activement, et 60 s de noir après un seul délai dépassé ressemblent à
// une panne franche. On garde les nuls passagers très courts pour que le
// déplacement suivant réessaie.
const SWISS_NULL_TTL_PERMANENT = 3600_000; // 1 h
const SWISS_NULL_TTL_TRANSIENT = 5_000;    // 5 s

// Plafonds des LRU. Chaque descripteur d'en-tête COG est petit (~4 Ko) ; chaque
// tuile interne décodée peut faire 256×256 Float32 = 256 Ko, mais on les garde
// parce que les tuiles Mercator voisines rééchantillonnent les mêmes tuiles internes.
const SWISS_HEADER_CACHE_MAX = 512;   // ≈2 MB
const SWISS_TILE_CACHE_MAX = 256;     // borne supérieure ≈ 64 Mo
const SWISS_STAC_CELL_CACHE_MAX = 16384; // Résolutions d'items STAC par cellule kilométrique LV95 (une fenêtre de 14×14 en écrit ~196 d'un coup)

// Limiteur de concurrence des COG — sémaphore distinct de celui de l'IGN, pour
// que le trafic France n'affame jamais le trafic Suisse, et inversement. Le
// banc d'essai du CDN (24 avril) montre que data.geo.admin.ch tient 32 flux à
// p95 = 2,5 s sans erreur. Passé de 24 à 32 (30 mai) une fois les fetchs
// d'en-têtes réduits à 32 Ko et les requêtes de plages regroupées : le VOLUME
// de fetch par tuile est bien plus faible et les flux supplémentaires
// écoulent plus vite la rafale d'un déplacement à froid sans saturer la file.
const SWISS_CONCURRENCY = 32;
const SWISS_QUEUE_MAX = 400;

// Fenêtre de regroupement STAC — chaque cellule s'aligne sur un bloc fixe
// (Ekm/STAC_GRID, Nkm/STAC_GRID), pour que les cellules sœurs rejoignent de
// façon déterministe la MÊME requête STAC en cours (déduplication par
// super-fenêtre, voir swiss-fetcher.js).
//   L'API STAC de swisstopo plafonne `limit` à 100 entités par page et pagine
//   via un `cursor` opaque dans le lien rel="next" de la réponse. On SUIT
//   désormais ce curseur (jusqu'à SWISS_STAC_MAX_PAGES) : une fenêtre peut
//   contenir bien plus de 100 cellules sans troncature silencieuse. Un bloc de
//   14×14 = 196 cellules × ~1,2 année publiée par cellule ≈ 235 entités =
//   3 pages, mais UNE fenêtre logique couvre désormais ~4× la surface de
//   l'ancien bloc de 7×7 → un déplacement de vue résout la découverte en
//   quelques fenêtres au lieu de ~15, et chaque tuile suivante du déplacement
//   lit ses cellules directement dans le cache.
const SWISS_STAC_GRID = 14;

// Taille de page STAC (le serveur plafonne à 100) et nombre maximal de pages de
// curseur suivies par fenêtre avant d'abandonner. 4 pages × 100 = 400 entités
// couvrent largement un bloc de 14×14 entièrement peuplé, même là où chaque
// cellule a 2 années d'acquisition publiées.
const SWISS_STAC_PAGE_LIMIT = 100;
const SWISS_STAC_MAX_PAGES = 6;

const SWISS_PRUNED_SENTINEL = Object.freeze({ _swissPruned: true });

// Saut rapide : à très faible zoom, la tuile couvre des dizaines de km² et il
// faudrait consulter STAC pour de nombreuses cellules juste pour découvrir que
// le pixel Mercator est déjà plus grossier que le COG. shouldUseSwiss() s'en
// charge, mais on borne aussi ici par précaution.
const SWISS_DEM_MINZOOM = 12;
