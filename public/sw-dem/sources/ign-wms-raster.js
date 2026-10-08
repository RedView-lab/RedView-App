// ---------------------------------------------------------------------------
// Rasters d'altitude WMS de l'IGN — géométrie de la requête (carrée en mètres),
// suréchantillonnage, fetch GetMap, suppression des lignes dupliquées par le
// plus proche voisin et rééchantillonnage en DEM_TILE_SIZE².
// ---------------------------------------------------------------------------

// ── Anticrénelage WMS : suréchantillonnage 2× + moyenne par blocs ─────
// Le WMS de geopf rééchantillonne sa pyramide au plus proche voisin. Si l'on
// demande exactement la grille de sortie, les échantillons crénèlent contre la
// grille LiDAR de 0,5 m et Horn en fait des bandes régulières de lignes et de
// colonnes (« hachures ») sur l'overlay des pentes. Demander 2× puis moyenner
// par blocs de 2×2 donne un vrai échantillonnage par surface.
// Mesuré sur 5 sites français de z14 à z16 (énergie des bandes lignes/colonnes
// du champ de pente, et |erreur| moyenne contre une référence à 4×) :
//   1× : bandes 0,46-1,62, erreur 0,63-7,54°
//   2× : bandes 0,20-0,78, erreur 0,26-3,03°   (référence 4× : 0,15-0,73)
// 3× est pire que 2× (découpage en blocs non entier) ; 2× sur un seul axe
// laisse les bandes de l'autre. Coûte 4× la charge utile (≈1,5 Mo par tuile,
// le BIL32 n'est pas compressé par geopf), d'où seulement à partir de z13, où
// l'overlay montre le détail LiDAR.
function ignWmsSupersampleFactor(mercZ) {
  return mercZ >= 13 ? 2 : 1;
}

// Le MNS 0,40 m reste à 1× : c'est le maillage 3D du fond de carte, demandé pour
// toute la vue à chaque chargement. À 2× (≈1,5 Mo par tuile), une vue z14 de
// 36 tuiles prenait 13 à 15 s et une vue z15 de 64 tuiles jusqu'à 19 s contre
// geopf (≈3,4 Mo/s, mesuré le 2026-10-01), au-delà d'IGN_FETCH_TIMEOUT_MS : les
// constructions abandonnées s'enchaînaient en replis MNT / RGE ALTI et en
// récupérations de surface, et la carte ne finissait jamais de charger. 1× :
// 4 s pour les mêmes vues.
function mnsWmsSupersampleFactor() {
  return 1;
}

// Un raster GetMap, géométrie en mètres carrés (voir mnsWmsRequestSize), flottants
// bruts srcWidth × srcHeight. null sur tout échec HTTP / de taille.
async function fetchWmsElevationRaster(layer, mercZ, mercX, mercY, supersample, init) {
  const { width, height } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
  const url = buildMnsWmsTileURL(mercZ, mercX, mercY, layer, width, height);
  const res = await fetchIgnWithRetry(url, init);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== width * height * 4) return null;
  return new Float32Array(buf);
}

function isValidWmsElevation(v) {
  return !Number.isNaN(v) && v >= MIN_VALID_ELEVATION_M && v <= MAX_VALID_ELEVATION_M;
}

// ── Géométrie des requêtes WMS : carrée en mètres, jamais en degrés ───
//
// Le WMS de l'IGN rééchantillonne chaque produit dans le CRS et la bbox
// demandés. Les produits sont stockés sur une grille CARRÉE EN MÈTRES, qui en
// EPSG:4326 est 1/cos(lat) PLUS LARGE que haute. Demander un raster carré en
// degrés (WIDTH === HEIGHT) force donc le serveur à étirer les lignes au plus
// proche voisin, ce qui en duplique la proportion 1 - cos(lat). Mesuré sur
// data.geopf.fr, le taux de duplication correspond à 1 - cos(lat) à 0,3 % près :
//   lat 42,8° -> prévu 26,6 %, mesuré 26,27 %
//   lat 45,1° -> prévu 29,4 %, mesuré 29,41 %
//   lat 48,3° -> prévu 33,5 %, mesuré 33,33 %
//
// Les lignes dupliquées sont catastrophiques pour l'overlay des pentes. Le
// noyau de Horn lit ∂z/∂y sur deux lignes adjacentes : le gradient alterne donc
// entre 0 et ~2× la vraie valeur d'une ligne à l'autre, et la rampe de couleurs
// peint le terrain en tirets horizontaux (l'artefact en « peigne ») au lieu
// d'un champ de pente lisse.
//
// Correction : demander un raster carré en mètres — 1/cos(lat) colonnes de PLUS
// que de lignes — en gardant DEM_TILE_SIZE lignes, pour ne perdre aucun détail
// vertical. Sur la couche MNS LiDAR HD, les lignes dupliquées passent de 29,4 %
// à 0,00 % et le peigne pair/impair du gradient de 0,018 à 0,000 (vérifié à
// 42,8 / 45,1 / 48,3°N). Les colonnes en trop sont ramenées à DEM_TILE_SIZE par
// moyenne par blocs dans `mnsWmsResampleToTile`.
//
// Remarque : l'EPSG:3857 n'est PAS une solution (mesuré : 22,4 % de lignes
// dupliquées et un peigne à 0,67 — la reprojection Mercator est pire), et la
// couche LiDAR HD n'est pas du tout publiée en EPSG:2154 (tuile constante).
function mnsWmsRequestSize(mercZ, mercX, mercY, supersample = 1) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const midLat = (bounds.north + bounds.south) / 2;
  const cosLat = Math.max(0.35, Math.min(1, Math.cos((midLat * Math.PI) / 180)));
  const height = DEM_TILE_SIZE * supersample;
  const width = Math.max(height, Math.round(height / cosLat));
  return { width, height };
}

// Charge utile d'un raster GetMap (BIL32, non compressé par geopf) : son poids
// dans le budget d'octets WMS de l'ordonnanceur (IGN_WMS_INFLIGHT_BYTES_MAX).
function wmsRasterBytes(mercZ, mercX, mercY, supersample = 1) {
  const { width, height } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
  return width * height * 4;
}

function buildMnsWmsTileURL(mercZ, mercX, mercY, layer, width, height) {
  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  return (
    `${IGN_WMS_BASE}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&FORMAT=${encodeURIComponent(IGN_DEM_FORMAT)}` +
    `&CRS=EPSG:4326&BBOX=${bbox}` +
    `&WIDTH=${width}&HEIGHT=${height}`
  );
}

// ── Annuler la duplication de lignes du plus proche voisin ────────────
// Une ligne identique au bit près à celle du dessus n'apporte aucune
// information : c'est le résidu du suréchantillonnage, par le serveur, des
// lignes de sa propre grille plus grossière. On remplace chaque suite de lignes
// identiques par une rampe linéaire entre les deux lignes distinctes qui
// l'encadrent, pour que le ∂z/∂y de Horn voie un gradient continu au lieu d'une
// alternance 0 / 2×.
//
// Sans danger sur un terrain vraiment plat : sur un lac ou un plateau, les
// lignes qui encadrent ont la même altitude et l'interpolation ne change rien.
function decombDuplicateRows(f, width, height) {
  if (width <= 0 || height <= 2) return 0;
  let repaired = 0;
  // Deux passes : la première nettoie les longues suites, la seconde rattrape
  // celles qui ne sont devenues adjacentes qu'une fois une suite plus longue
  // découpée par la première passe.
  for (let pass = 0; pass < 2; pass++) {
    let run = 0;
    for (let y = 1; y <= height; y++) {
      let duplicate = false;
      if (y < height) {
        duplicate = true;
        const a = (y - 1) * width;
        const b = y * width;
        for (let x = 0; x < width; x++) {
          if (f[a + x] !== f[b + x]) { duplicate = false; break; }
        }
      }
      if (duplicate) { run++; continue; }
      if (run > 0) {
        const topRow = y - run - 1;
        const bottomRow = y < height ? y : -1;
        if (topRow >= 0 && bottomRow >= 0) {
          const topOff = topRow * width;
          const bottomOff = bottomRow * width;
          for (let k = 1; k <= run; k++) {
            const t = k / (run + 1);
            const off = (topRow + k) * width;
            for (let x = 0; x < width; x++) {
              const a = f[topOff + x];
              f[off + x] = a + (f[bottomOff + x] - a) * t;
            }
          }
          repaired += run;
        }
      }
      run = 0;
    }
  }
  return repaired;
}

// Rééchantillonne un raster WMS de géométrie quelconque en DEM_TILE_SIZE².
// Moyenne par blocs qui tient compte de NaN / NODATA : un pixel sentinelle
// n'empoisonne jamais une cellule.
function mnsWmsResampleToTile(raw, srcWidth, srcHeight) {
  if (srcWidth === DEM_TILE_SIZE && srcHeight === DEM_TILE_SIZE) {
    decombDuplicateRows(raw, DEM_TILE_SIZE, DEM_TILE_SIZE);
    return raw;
  }
  const out = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const sx = srcWidth / DEM_TILE_SIZE;
  const sy = srcHeight / DEM_TILE_SIZE;
  // Les plages de colonnes ne dépendent que de x — calculées une fois, pas pour chaque pixel.
  const colStart = new Int32Array(DEM_TILE_SIZE);
  const colEnd = new Int32Array(DEM_TILE_SIZE);
  for (let x = 0; x < DEM_TILE_SIZE; x++) {
    const x0 = Math.floor(x * sx);
    colStart[x] = x0;
    colEnd[x] = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
  }
  for (let y = 0; y < DEM_TILE_SIZE; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    const outRow = y * DEM_TILE_SIZE;
    for (let x = 0; x < DEM_TILE_SIZE; x++) {
      const x0 = colStart[x];
      const x1 = colEnd[x];
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcWidth;
        for (let xx = x0; xx < x1; xx++) {
          const v = raw[row + xx];
          if (!Number.isNaN(v) && v >= MIN_VALID_ELEVATION_M && v <= MAX_VALID_ELEVATION_M) {
            sum += v;
            n++;
          }
        }
      }
      out[outRow + x] = n > 0 ? sum / n : NaN;
    }
  }
  decombDuplicateRows(out, DEM_TILE_SIZE, DEM_TILE_SIZE);
  return out;
}
