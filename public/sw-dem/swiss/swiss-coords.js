// ---------------------------------------------------------------------------
// Conversion de coordonnées WGS84 ↔ LV95 (CH1903+ / EPSG:2056)
// ---------------------------------------------------------------------------
// Référence : « solution approchée » de swisstopo — précise à ~1 m, largement
// assez pour échantillonner une grille de 0,5 m par interpolation bilinéaire.
//   https://www.swisstopo.admin.ch/content/swisstopo-internet/en/online/
//   calculation-services/_jcr_content/contentPar/tabs/items/documents_publi
//   cation/tabPar/downloadlist/downloadItems/19_1467104436749.download/
//   ch1903wgs84_e.pdf
//
// On évite volontairement d'importer proj4 dans le service worker : le SW est
// un worker classique (importScripts) et proj4 est livré en ESM dans le projet.
// Les polynômes explicites ci-dessous font moins de 80 opérations et n'ont
// aucune dépendance.
// ---------------------------------------------------------------------------

function wgs84ToLV95(lng, lat) {
  // Convertit des degrés décimaux en « secondes d'arc swisstopo mises à l'échelle »
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lng * 3600 - 26782.5) / 10000;

  const E = 2600072.37
    + 211455.93 * lam
    -  10938.51 * lam * phi
    -      0.36 * lam * phi * phi
    -     44.54 * lam * lam * lam;

  const N = 1200147.07
    + 308807.95 * phi
    +   3745.25 * lam * lam
    +     76.63 * phi * phi
    -    194.56 * lam * lam * phi
    +    119.79 * phi * phi * phi;

  return { E, N };
}

function lv95ToWGS84(E, N) {
  const y = (E - 2600000) / 1000000;
  const x = (N - 1200000) / 1000000;

  let lam = 2.6779094
    + 4.728982 * y
    + 0.791484 * y * x
    + 0.1306   * y * x * x
    - 0.0436   * y * y * y;

  let phi = 16.9023892
    + 3.238272 * x
    - 0.270978 * y * y
    - 0.002528 * x * x
    - 0.0447   * y * y * x
    - 0.0140   * x * x * x;

  // Les polynômes swisstopo donnent des « 10 000 grades » — conversion en degrés décimaux
  return { lng: lam * 100 / 36, lat: phi * 100 / 36 };
}

// ---------------------------------------------------------------------------
// Classement du recouvrement des tuiles avec la Suisse — par bbox seulement
// (pas de polygone de frontière précis). Les bornes natives LV95 rejettent
// proprement : une tuile Mercator dont la conversion tombe entièrement hors de
// [Emin..Emax]×[Nmin..Nmax] est forcément hors de la couverture swissSURFACE3D
// publiée. On ne tente pas un classement fin « intérieur ou bord », car le
// fetcher de COG gère déjà proprement « aucun item pour cette cellule
// kilométrique LV95 » (il met en cache un nul définitif).
// ---------------------------------------------------------------------------

function tileOverlapsSwitzerland(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = SWITZERLAND_BOUNDS;
  if (b.east < w || b.west > e || b.south > n || b.north < s) return false;
  // Projette les quatre coins en LV95 et rejette si tous sont dehors.
  const corners = [
    wgs84ToLV95(b.west, b.south),
    wgs84ToLV95(b.east, b.south),
    wgs84ToLV95(b.east, b.north),
    wgs84ToLV95(b.west, b.north),
  ];
  let allOut = true;
  for (const c of corners) {
    if (
      c.E >= SWISS_LV95_BOUNDS.Emin && c.E <= SWISS_LV95_BOUNDS.Emax &&
      c.N >= SWISS_LV95_BOUNDS.Nmin && c.N <= SWISS_LV95_BOUNDS.Nmax
    ) { allOut = false; break; }
  }
  if (allOut) {
    // La tuile peut encore traverser l'emprise LV95 en diagonale — on est
    // tolérant et on accepte toute tuile dont un coin est dans les bornes WGS84.
    // Le fetcher de COG renverra null pour les cellules sans donnée publiée.
    return true;
  }
  return true;
}

// Associe une tuile Mercator à la plage (Ekm, Nkm) des cellules LV95 de 1 km
// qu'elle couvre. Renvoie des plages de cellules inclusives, pour que
// l'appelant parcoure la grille.
function mercTileToLV95KmCells(z, x, y) {
  const b = mercatorTileBounds(z, x, y);
  const corners = [
    wgs84ToLV95(b.west, b.south),
    wgs84ToLV95(b.east, b.south),
    wgs84ToLV95(b.east, b.north),
    wgs84ToLV95(b.west, b.north),
  ];
  let Emin = Infinity, Emax = -Infinity, Nmin = Infinity, Nmax = -Infinity;
  for (const c of corners) {
    if (c.E < Emin) Emin = c.E;
    if (c.E > Emax) Emax = c.E;
    if (c.N < Nmin) Nmin = c.N;
    if (c.N > Nmax) Nmax = c.N;
  }
  // Bornage à l'emprise publiée
  Emin = Math.max(Emin, SWISS_LV95_BOUNDS.Emin);
  Emax = Math.min(Emax, SWISS_LV95_BOUNDS.Emax);
  Nmin = Math.max(Nmin, SWISS_LV95_BOUNDS.Nmin);
  Nmax = Math.min(Nmax, SWISS_LV95_BOUNDS.Nmax);
  if (Emin > Emax || Nmin > Nmax) return null;
  return {
    EkmMin: Math.floor(Emin / 1000),
    EkmMax: Math.floor(Emax / 1000),
    NkmMin: Math.floor(Nmin / 1000),
    NkmMax: Math.floor(Nmax / 1000),
  };
}
