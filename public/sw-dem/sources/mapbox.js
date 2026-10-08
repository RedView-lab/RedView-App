// ---------------------------------------------------------------------------
// Adaptateur de compatibilité pour le repli DEM mondial.
//
// Les appelants existants invoquent toujours `fetchMapboxTile(...)`, mais ce nom
// n'est plus qu'historique : l'implémentation réelle utilise AWS Open Data
// Terrarium et n'appelle plus jamais Mapbox terrain-DEM v1.
// ---------------------------------------------------------------------------

// Plafond d'engagement du remplissage AWS pour le chemin de repli DEM mondial.
//
// Il est volontairement PLUS BAS que `DEM_SOURCE_MAXZOOM` (= 17 dans
// ign.config.ts). Ce n'est PAS le zoom maximal de la source — c'est le seuil
// au-delà duquel le SW ne doit PAS mélanger des données AWS mondiales à 30 m
// dans les tuiles IGN. Au-delà de mercZ 15 en France, on sert du MNS LiDAR HD
// de l'IGN pur (ou une tuile IGN parente suréchantillonnée en bicubique) ;
// contaminer ces tuiles avec AWS recréerait le « flou à 30 m » signalé par
// l'utilisateur sur les surfaces de bâtiments et d'arbres.
//
// AWS Terrarium n'est natif que jusqu'à z14 ; à z15 le SW suréchantillonne en
// bicubique le parent z14, ce qui préserve assez de relief pour le contrat de
// la source. Au-delà de z15, en France comme ailleurs, le rendu repose soit
// sur le vrai MNS IGN (France), soit sur le suréchantillonnage GPU de Mapbox
// GL à partir de la dernière tuile construite avec succès.
const MAPBOX_DEM_MAXZOOM = 15;

async function fetchMapboxTile(z, x, y) {
  return fetchAWSTerrainTile(z, x, y);
}
