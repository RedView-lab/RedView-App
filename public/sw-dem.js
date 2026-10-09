// ---------------------------------------------------------------------------
// Service Worker — construction côté client des tuiles DEM + ortho + pente + altitude
//
// POINT D'ENTRÉE MINIMAL — ne fait que charger les sous-modules par
// importScripts(). Toute la logique vit dans les sous-dossiers de /sw-dem/,
// rangés par responsabilité :
//
//   /sw-dem/core/               — config, géométrie, interpolation, décodage RGB.
//   /sw-dem/sources/            — adaptateurs de récupération IGN / AWS / Mapbox / ortho / ortho THR.
//   /sw-dem/processing/         — construction des tuiles, composition, calculs pente et altitude.
//   /sw-dem/swiss/              — config, coordonnées, COG, récupération, construction swissSURFACE3D.
//   /sw-dem/norway/             — config, coordonnées, construction du WCS NHM DTM norvégien.
//   /sw-dem/spain/              — config, coordonnées, construction du WCS MDT espagnol.
//   /sw-dem/runtime/            — cycle de vie, routeur, fonctions d'appui, santé, handlers.
//
// Contrat avec la page (useMap.ts) :
//   1. la page enregistre le SW et attend controllerchange
//   2. SEULEMENT ENSUITE elle ajoute les sources /dem-tiles/ et /ortho-tiles/
//
// Conséquence : les fetchs de DEM ne dépendent que de sources locales ou
// publiques (IGN / swissALTI / AWS Terrarium). On ne synthétise JAMAIS de fausse
// tuile d'altitude « plate » ; sur un vrai échec on renvoie 204, pour que le
// rendu puisse réutiliser le maillage parent.
// ---------------------------------------------------------------------------
// Tampon de cache — modifié à chaque changement qui invalide le cache, pour que
// le navigateur détecte une différence d'octets dans ce fichier et déclenche
// install→activate→purge.
// Actuel : dem-tiles-v54-rgb-up-rle / radar-v4-opera / dem-negative-v30 / slope-tiles-v3-rle / vhr-tiles-v1 / altitude-stale-v1
// 2026-10-09 radar-v4-opera : radar européen EUMETNET OPERA (CC BY 4.0) à la place
// de RainViewer (API gratuite réservée à l'usage personnel) ; le Service Worker
// relaie les tuiles /radar-tiles au serveur, qui les fabrique, au lieu de recolorer
// des tuiles RainViewer. Aucun nom de cache ne change.
// 2026-10-08 commentaires seulement : commentaires des modules traduits en
// français ; runtime/router.js et radar-handler.js citent
// server/lib/http-security.mjs (déplacé). Aucun nom de cache ne change : rien
// n'est purgé.
// 2026-10-07 ortho-transparent-literal : une tuile ortho manquante reçoit le
// littéral TRANSPARENT_PNG vérifié (runtime/dem-helpers.js) au lieu d'un encodage
// OffscreenCanvas, qui pouvait rejeter le fetch (audit d-sw-router, 15 échecs →
// 0). Octets des vraies tuiles inchangés.
// 2026-10-07 dem-rgb-up-rle : la tuile DEM Terrain-RGB (encodeTerrainRGBPng) est
// en RGB avec le filtre Up du PNG, compressée par zlibDeflateRle, au lieu d'un
// RGBA non filtré passé par le niveau 6 de CompressionStream : encodage 1,7 à
// 3,3× plus rapide et 10 à 36 % plus petit dans Chromium (vraies tuiles
// Terrarium et surface bruitée de type 0,40 m), mêmes altitudes. Les anciennes
// tuiles restent valides (tout décodeur lit les deux) — MAP_CACHE_EPOCH inchangé.
// 2026-10-06 slope-rle : la tuile de pente grise opaque (buildGrayPng) est
// compressée par zlibDeflateRle (core/terrain-rgb.js : correspondances à
// distance 1 + Huffman dynamique, le Z_RLE de zlib) au lieu du niveau 6 de
// CompressionStream, dont la recherche de correspondances coûtait 20 à 33 ms par
// tuile 512² dans Chromium pour la même taille ; la construction complète d'une
// tuile de pente est passée de 24 à 11 ms. Mêmes pixels, octets PNG différents :
// les tuiles en cache restent valides — MAP_CACHE_EPOCH inchangé.
// 2026-10-04 video-final : les rasters WMS LiDAR HD sont envoyés sous un budget
// d'octets en vol (ign-scheduler.js) au lieu de 64 à la fois — sur une ligne
// d'environ 2 Mo/s ils dépassaient le délai de fetch de 15 s et les tuiles
// retombaient sur des remplaçants (42 % du relief d'une vidéo de survol en
// 0,40 m). Les requêtes de terrain de la vidéo de survol (`rv-src=video`) sautent
// les remplaçants et réessaient une construction provisoire jusqu'à 30 s
// (dem-handler/index.js). Octets des tuiles inchangés — MAP_CACHE_EPOCH inchangé.
// 2026-10-03 altitude-stale : une requête /altitude-tiles dont la tuile DEM
// n'était pas encore définitive (LiDAR en attente sous charge, construction
// annulée, remplaçant) répondait une tuile transparente que Mapbox gardait pour
// de bon — des trous dans l'overlay d'altitude à froid. Elle sert désormais le
// DEM ancêtre en cache suréchantillonné, sans mise en cache, et la page recharge
// la source sur ALTITUDE_TILES_STALE quand la vraie tuile arrive (suivi partagé
// avec la pente : runtime/derived-tile-stale.js). Octets des tuiles inchangés —
// MAP_CACHE_EPOCH inchangé.
// 2026-10-03 module-split : sources/ign-fetcher.js, processing/build-tile.js et
// runtime/lifecycle.js découpés en scripts plus petits (même code, nouvelle
// liste d'importScripts). Octets des tuiles inchangés — MAP_CACHE_EPOCH inchangé.
// 2026-10-02 gesture-cancel : un geste de caméra (rotation, inclinaison,
// déplacement, zoom) ne vide / n'annule plus les fetchs LiDAR des tuiles de
// terrain encore à l'écran — elles retombaient sur le MNS de corrélation / AWS à
// 30 m et restaient ainsi en cache (relief qui « saute » à 30 m en tournant la
// caméra). La page envoie les tuiles DEM qu'elle attend encore
// (DEM_WANTED_TILES) : seul le travail des autres est abandonné. Un fetch annulé
// est réessayé ou reçoit une 204 sans mise en cache, jamais enregistré comme
// repli ; une surface MNS de l'ancien chemin est provisoire (cache court +
// récupération WMS). MAP_CACHE_EPOCH modifié (purge).
// 2026-10-02 vhr-ortho : overlay /vhr-tiles (fond satellite, z18–21, 512 px) —
// PCRS 5 cm + THR 5–10 cm de l'IGN via WMS-R en EPSG:3857, conditionné par des
// masques de couverture z14 par couche, transparent ailleurs pour laisser voir
// Mapbox Satellite.
// 2026-10-01 slope-terrain-aligned : l'overlay demande les tuiles DEM du terrain
// 3D lui-même (z = floor(zoom − 1) au lieu de round(zoom + 1) : 16 à 64× moins de
// constructions de DEM), pente Catmull-Rom 2× gris+alpha, taille de cellule par
// ligne, voisines en cours attendues, tuiles provisoires reconstruites quand le
// DEM manquant arrive, repli sur la pente du parent au lieu de trous, pas
// d'annulation sur geste (passage direct pente et altitude), DEM de remplacement
// plus figés par le résolveur.
// 2026-10-01 mns-1x : le MNS 0,40 m (fond de carte 3D) est de nouveau demandé en
// 1× — le 2× faisait dépasser le délai IGN de 15 s à des vues entières et la carte
// ne se chargeait jamais. L'anticrénelage 2× ne reste que sur le WMS terrain à 1 m.
// 2026-10-01 surface-standin : un échec passager du MNS (0,40 m) ne met plus en
// cache du sol nu pour de bon — overzoom du parent en cache d'abord, chaque
// remplaçant brièvement en cache, récupération du MNS en arrière-plan (les
// bâtiments restaient plats au zoom avant).
// 2026-10-01 slope-lidar-wms-v2 : WMS LiDAR HD demandé en 2× + moyenné par blocs
// (plus de hachures en lignes / colonnes), terrain à 1 m sur le MNT LiDAR HD (RGE
// ALTI ne fait que combler les trous), geopf 400 LayerNotDefined / 429 réessayés
// + WMS gardé sous 40 req/s, plus de plateau à 0 m quand une tuile partielle n'a
// pas de fond, LRU des DEM du worker indexé par contenu, tuiles de pente
// provisoires gardées hors du niveau chaud et rechargées par la page
// (SLOPE_TILES_STALE) — trous de remplaçants après un geste.
// 2026-10-01 slope-hd-outside-lidar : test de frontière France par les arêtes du
// polygone (plus de bbox FRANCE_BOUNDS → nord-ouest de l'Italie / BE / LU / DE
// repassent sur AWS), pente HD hors emprises LiDAR = pente à 30 m (z>13
// suréchantillonné depuis z13), raccord des voisines de même classe, fuite de
// créneaux de fetch AWS corrigée, message CLAIM_CLIENTS.
// 2026-10-01 security : liste d'hôtes autorisés pour le radar + plus de passage brut, les navigations contournent le SW.
// 2026-10-01 tiles : PNG transparent 1x1 valide (CRC IDAT faux avant) + le routeur
// rejette par une 204 les coordonnées de tuiles impossibles (z>22, x/y >= 2^z).
// 2026-08 zone-gated overlays : les tuiles pente / altitude peuvent porter
// ?zone=<hash> (masquées, clés de cache séparées) ; registre de zone d'analyse +
// masque par pixel (v5 Uniform Fast LiDAR).
// 2026-09-30 altitude-passthrough : /altitude-tiles (HD seulement) est un alias
// en lecture du cache DEM du profil actif — aucune écriture de cache d'altitude,
// aucune construction de DEM au-dessus de z14.
// 2026-09-30 hd-perf-1 : garde-fou de santé en cache seulement (pas de
// construction de parent ni d'aller-retour d'overzoom), LRU de décodage borné
// amorcé par l'encodeur, ordonnancement WMS du centre vers les bords, routes
// statiques (les requêtes hors tuiles contournent le SW). Octets des tuiles
// inchangés — MAP_CACHE_EPOCH volontairement inchangé.
// ---------------------------------------------------------------------------

const swModuleEpoch = new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base';
const withEpoch = (path) => `${path}?rv-map-cache-epoch=${encodeURIComponent(swModuleEpoch)}`;

importScripts(
  // ── Primitives du pipeline (config + maths + récupérateurs bas niveau) ──
  withEpoch('/sw-dem/core/logger.js'),
  withEpoch('/sw-dem/core/config.js'),
  withEpoch('/sw-dem/core/geo.js'),
  withEpoch('/sw-dem/core/analysis-zone.js'),
  withEpoch('/sw-dem/core/interpolation.js'),
  withEpoch('/sw-dem/core/terrain-rgb.js'),
  withEpoch('/sw-dem/sources/ign-scheduler.js'),
  withEpoch('/sw-dem/sources/ign-network.js'),
  withEpoch('/sw-dem/sources/ign-cancel.js'),
  withEpoch('/sw-dem/sources/ign-fetcher.js'),
  withEpoch('/sw-dem/sources/ign-highres.js'),
  withEpoch('/sw-dem/sources/ign-wms-raster.js'),
  withEpoch('/sw-dem/sources/ign-wms-tiles.js'),
  withEpoch('/sw-dem/sources/mapbox.js'),
  withEpoch('/sw-dem/sources/aws-terrain.js'),
  withEpoch('/sw-dem/processing/build-tile-support.js'),
  withEpoch('/sw-dem/processing/build-tile.js'),
  withEpoch('/sw-dem/processing/build-fallback-tile.js'),
  withEpoch('/sw-dem/processing/build-terrain-tile.js'),
  withEpoch('/sw-dem/processing/composite.js'),
  withEpoch('/sw-dem/sources/ortho.js'),
  withEpoch('/sw-dem/sources/vhr-ortho.js'),
  withEpoch('/sw-dem/processing/slope.js'),
  withEpoch('/sw-dem/processing/altitude.js'),
  // Switzerland — swissSURFACE3D Raster (COG over STAC, 0.5 m LiDAR DSM)
  withEpoch('/sw-dem/swiss/swiss-config.js'),
  withEpoch('/sw-dem/swiss/swiss-coords.js'),
  withEpoch('/sw-dem/swiss/swiss-cog.js'),
  withEpoch('/sw-dem/swiss/swiss-fetcher.js'),
  withEpoch('/sw-dem/swiss/swiss-build.js'),
  // Norvège — MNT national via le WCS Kartverket / Geonorge (UTM 32/33/35)
  withEpoch('/sw-dem/norway/norway-config.js'),
  withEpoch('/sw-dem/norway/norway-coords.js'),
  withEpoch('/sw-dem/norway/norway-build.js'),
  // Espagne — MDT national 5 m via le WCS IGN / IDEE
  withEpoch('/sw-dem/spain/spain-config.js'),
  withEpoch('/sw-dem/spain/spain-coords.js'),
  withEpoch('/sw-dem/spain/spain-build.js'),

  // ── Orchestration du SW (cycle de vie + handlers) ─────────────────────
  // L'ordre ne compte que pour la déclaration avant usage des `const` / `let`
  // à l'évaluation du module. Toutes les références croisées ont lieu dans des
  // événements fetch qui se déclenchent APRÈS la phase d'installation : les
  // fonctions peuvent donc être définies dans n'importe quel ordre. On charge
  // d'abord les caches chauds, les files de construction (Maps globales des
  // requêtes en cours + limiteur de composition) et le cycle de vie, puis les
  // fonctions d'appui, puis les handlers, puis le routeur (qui ne fait
  // qu'enregistrer un écouteur).
  //
  // slope-pool.js (le gestionnaire du pool de Workers dédié) DOIT être chargé
  // avant slope-handler.js — handleSlopeRequest référence computeSlopeViaPool à
  // l'appel, et cancelSlopeWork() (dans lifecycle.js) référence
  // cancelAllSlopePoolJobs. Ce sont de simples déclarations de fonctions, donc
  // les appels réels ont lieu bien après la fin de ce bloc importScripts, mais
  // garder l'ordre stable rend la dépendance évidente.
  withEpoch('/sw-dem/workers/slope-math.js'),
  withEpoch('/sw-dem/runtime/hot-caches.js'),
  withEpoch('/sw-dem/runtime/build-queues.js'),
  withEpoch('/sw-dem/runtime/lifecycle.js'),
  withEpoch('/sw-dem/runtime/dem-helpers.js'),
  withEpoch('/sw-dem/runtime/dem-health.js'),
  withEpoch('/sw-dem/runtime/upgrade-scheduler.js'),
  // Avant slope-handler.js / altitude-handler.js : tous deux créent leur suivi
  // des tuiles périmées à l'évaluation.
  withEpoch('/sw-dem/runtime/derived-tile-stale.js'),
  withEpoch('/sw-dem/runtime/dem-handler.js'),
  withEpoch('/sw-dem/runtime/slope-pool.js'),
  withEpoch('/sw-dem/runtime/slope-handler.js'),
  withEpoch('/sw-dem/runtime/altitude-handler.js'),
  withEpoch('/sw-dem/runtime/radar-handler.js'),
  withEpoch('/sw-dem/runtime/router.js'),
);
