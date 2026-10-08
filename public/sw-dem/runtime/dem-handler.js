// ---------------------------------------------------------------------------
// Chargeur du handler des tuiles DEM — point d'entrée racine stable, gardé pour
// l'ordre de chargement du service worker, la stabilité des caches et la
// compatibilité des chemins d'import.
//
// L'implémentation vit désormais dans /runtime/dem-handler/.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/runtime/dem-handler/compute-request.js',
  '/sw-dem/runtime/dem-handler/index.js',
);