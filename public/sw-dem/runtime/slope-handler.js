// ---------------------------------------------------------------------------
// Chargeur du handler des tuiles de pente — point d'entrée racine stable, gardé
// pour l'ordre de chargement du service worker, la stabilité des caches et la
// compatibilité des chemins d'import.
//
// L'implémentation vit désormais dans /runtime/slope-handler/.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/runtime/slope-handler/slope-helpers.js',
  '/sw-dem/runtime/slope-handler/slope-lidar-dem.js',
  '/sw-dem/runtime/slope-handler/slope-builders.js',
  '/sw-dem/runtime/slope-handler/slope-request.js',
  '/sw-dem/runtime/slope-handler/slope-zone-pipeline.js',
);
