export const FRANCE_BOUNDS: [number, number, number, number] = [-5.5, 41.0, 10.0, 51.5];

// La source raster-dem est déclarée jusqu'à z17 pour que Mapbox demande vraiment
// les tuiles MNS LiDAR HD de l'IGN à leur résolution native (~2,5 m/px à la
// latitude 48° de Paris). En dessous, le GPU suréchantillonnait un maillage z15
// lissé, ce qui effaçait les arêtes de bâtiments et d'arbres encodées par le
// modèle de surface — visible en vue oblique comme une ville plate où seul le
// relief du sol transparaissait.
//
// Le SW gère z16/z17 en France par le pipeline MNS de l'IGN (voir
// `IGN_DEM_MAXZOOM = 17` dans sw-dem/core/config.js). Hors de France, le SW sert
// le parent AWS Terrarium suréchantillonné en bicubique (le même chemin qu'il
// utilisait déjà à z15) — Mapbox GL suréchantillonne ensuite sur GPU le dernier
// maillage stable, comme avant mais en partant d'une base plus élevée : la
// qualité du terrain mondial ne change pas.
export const DEM_SOURCE_MAXZOOM = 17;
