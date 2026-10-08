// ---------------------------------------------------------------------------
// Calcul des pentes — fonctions PURES partagées par le chemin du SW dans le
// processus courant (slope.js) et le pool de workers dédié aux pentes
// (slope-pool.worker.js).
//
// RIEN dans ce fichier ne doit référencer de global propre au SW (pas de
// SLOPE_INFLIGHT, de demCache, de caches, de self.clients). Il ne dépend que de :
//   - constantes de config (DEM_TILE_SIZE, DEM_NODATA_THRESHOLD, …)
//   - terrain-rgb.js      (buildGrayPng, buildGrayAlphaPng)
//
// slope.js (repli dans le processus courant) et le worker chargent tous deux ce
// module par importScripts : le noyau de Horn, le suréchantillonnage et
// l'encodage PNG vivent à UN seul endroit, et les sorties du pool et du
// processus courant sont identiques à l'octet près.
//
// Pipeline (buildSlopePngFromElevations) :
//   1. tuile DEM propre + bordure de 3 cellules prise aux 4 tuiles voisines cardinales
//   2. pente de Horn 3×3 sur la tuile et 2 cellules au-delà de chaque bord,
//      taille de cellule au sol par ligne (le Web Mercator est conforme : même
//      espacement en x et en y à une latitude donnée)
//   3. encodage en gamma racine : valeur = sqrt(deg / 90) · 255, gardée continue
//   4. sortie : résolution native (tuiles de zone) ou suréchantillonnage
//      Catmull-Rom 2× du champ encodé (tuiles alignées sur le terrain, voir
//      slope-source.ts)
//   5. PNG gris — gris + alpha seulement là où un masque NoData / de zone
//      d'analyse rend une partie de la tuile transparente
//
// Pourquoi suréchantillonner la PENTE et jamais le DEM : Horn sur un DEM
// interpolé transforme la courbure de la spline en ondulations au pas de la
// source. Le champ de pente lui-même est interpolé ici exactement comme le
// ferait le GPU (mais avec une cubique lisse au lieu de facettes bilinéaires),
// et la marge de 2 cellules calculée à partir des DEM voisins fait interpoler
// les mêmes valeurs à deux tuiles adjacentes sur leur bord commun — pas de jointure.
// ---------------------------------------------------------------------------

const SLOPE_EARTH_CIRCUMFERENCE_M = 40075016.686;
// encoded = sqrt(atan(g) / (π/2)) · 255 = sqrt(deg / 90) · 255
const SLOPE_ENC_K = 255 / Math.sqrt(Math.PI / 2);

// Cellules de DEM empruntées à chaque voisine : Horn en a besoin d'1, le
// suréchantillonnage Catmull-Rom a besoin de la pente 2 cellules au-delà du
// bord, d'où 3.
const SLOPE_DEM_BORDER = 3;
const SLOPE_FIELD_MARGIN = SLOPE_DEM_BORDER - 1;

// Poids Catmull-Rom d'un suréchantillonnage 2× échantillonné aux centres des
// pixels : le pixel de sortie 2i est à la position source i − 0,25 (échantillons
// i−2 … i+1), 2i+1 à i + 0,25 (échantillons i−1 … i+2).
const SLOPE_CR_EVEN = [-0.0234375, 0.2265625, 0.8671875, -0.0703125];
const SLOPE_CR_ODD = [-0.0703125, 0.8671875, 0.2265625, -0.0234375];

// ── Tampon d'altitudes élargi à partir d'altitudes voisines DÉJÀ décodées ──
// `neighbourElevations` vaut { north?, east?, south?, west? }, chaque valeur
// étant un Float32Array(S*S). Les voisines manquantes sont extrapolées
// linéairement (seule la première cellule de bordure alimente une valeur de
// pente gardée — voir replicateMissingSlopeMargins). Les coins n'ont pas de
// voisine diagonale : extrapolation par plan bilinéaire des deux bandes adjacentes.
function buildPaddedElevationsFromArrays(ownElev, neighbourElevations) {
  const S = DEM_TILE_SIZE;
  const B = SLOPE_DEM_BORDER;
  const P = S + 2 * B;
  const pad = new Float32Array(P * P);
  const nN = neighbourElevations?.north || null;
  const nE = neighbourElevations?.east || null;
  const nS = neighbourElevations?.south || null;
  const nW = neighbourElevations?.west || null;
  const missingDirections = [];
  if (!nN) missingDirections.push('north');
  if (!nE) missingDirections.push('east');
  if (!nS) missingDirections.push('south');
  if (!nW) missingDirections.push('west');

  for (let r = 0; r < S; r++) {
    pad.set(ownElev.subarray(r * S, (r + 1) * S), (r + B) * P + B);
  }

  // North strip: tile rows −1 … −B.
  for (let k = 1; k <= B; k++) {
    const dst = (B - k) * P + B;
    if (nN) {
      pad.set(nN.subarray((S - k) * S, (S - k + 1) * S), dst);
    } else {
      for (let c = 0; c < S; c++) pad[dst + c] = ownElev[c] + k * (ownElev[c] - ownElev[S + c]);
    }
  }
  // South strip: tile rows S … S+B−1.
  for (let k = 0; k < B; k++) {
    const dst = (B + S + k) * P + B;
    if (nS) {
      pad.set(nS.subarray(k * S, (k + 1) * S), dst);
    } else {
      const last = (S - 1) * S;
      const prev = (S - 2) * S;
      for (let c = 0; c < S; c++) {
        pad[dst + c] = ownElev[last + c] + (k + 1) * (ownElev[last + c] - ownElev[prev + c]);
      }
    }
  }
  // West / east strips.
  for (let r = 0; r < S; r++) {
    const row = (r + B) * P;
    const src = r * S;
    for (let k = 1; k <= B; k++) {
      pad[row + B - k] = nW
        ? nW[src + S - k]
        : ownElev[src] + k * (ownElev[src] - ownElev[src + 1]);
    }
    for (let k = 0; k < B; k++) {
      pad[row + B + S + k] = nE
        ? nE[src + k]
        : ownElev[src + S - 1] + (k + 1) * (ownElev[src + S - 1] - ownElev[src + S - 2]);
    }
  }
  // Corner blocks.
  const fillCorner = (r0, r1, c0, c1) => {
    for (let r = r0; r < r1; r++) {
      const re = r < B ? B : B + S - 1;
      for (let c = c0; c < c1; c++) {
        const ce = c < B ? B : B + S - 1;
        pad[r * P + c] = pad[r * P + ce] + pad[re * P + c] - pad[re * P + ce];
      }
    }
  };
  fillCorner(0, B, 0, B);
  fillCorner(0, B, B + S, P);
  fillCorner(B + S, P, 0, B);
  fillCorner(B + S, P, B + S, P);

  return { pad, missingDirections };
}

// ── Champ de pente de Horn (encodé, continu) ──────────────────────────
// Couvre la tuile plus SLOPE_FIELD_MARGIN cellules au-delà de chaque bord :
// F = S + 2·M cellules par côté. La taille de cellule au sol suit la latitude de
// chaque ligne ; une seule valeur par tuile faussait de plusieurs pour cent les
// tuiles de faible zoom entre leur première et leur dernière ligne et laissait
// une marche à chaque jointure horizontale.
function computeSlopeField(pad, z, y) {
  const S = DEM_TILE_SIZE;
  const B = SLOPE_DEM_BORDER;
  const M = SLOPE_FIELD_MARGIN;
  const P = S + 2 * B;
  const F = S + 2 * M;
  const field = new Float32Array(F * F);
  const worldRows = S * 2 ** z;
  const metresPerCellAtEquator = SLOPE_EARTH_CIRCUMFERENCE_M / worldRows;

  for (let fr = 0; fr < F; fr++) {
    const tileRow = fr - M;
    const mercN = Math.PI * (1 - (2 * (y * S + tileRow + 0.5)) / worldRows);
    const cell = metresPerCellAtEquator * Math.cos(Math.atan(Math.sinh(mercN)));
    const inv8 = 1 / (8 * cell);
    const pr = tileRow + B;
    const r0 = (pr - 1) * P;
    const r1 = pr * P;
    const r2 = (pr + 1) * P;
    const out = fr * F;
    for (let fc = 0; fc < F; fc++) {
      const pc = fc - M + B;
      const a = pad[r0 + pc - 1];
      const b = pad[r0 + pc];
      const c = pad[r0 + pc + 1];
      const d = pad[r1 + pc - 1];
      const f = pad[r1 + pc + 1];
      const g = pad[r2 + pc - 1];
      const h = pad[r2 + pc];
      const i = pad[r2 + pc + 1];
      const dzDx = ((c + 2 * f + i) - (a + 2 * d + g)) * inv8;
      const dzDy = ((g + 2 * h + i) - (a + 2 * b + c)) * inv8;
      field[out + fc] = Math.sqrt(Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy))) * SLOPE_ENC_K;
    }
  }
  return field;
}

// Au-delà d'un bord sans tuile voisine, la marge viendrait d'altitudes
// extrapolées : on réplique plutôt la pente du bord.
function replicateMissingSlopeMargins(field, missingDirections) {
  if (!missingDirections.length) return;
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const missing = new Set(missingDirections);
  if (missing.has('north')) {
    for (let fr = 0; fr < M; fr++) field.copyWithin(fr * F, M * F, M * F + F);
  }
  if (missing.has('south')) {
    const edge = (M + S - 1) * F;
    for (let fr = M + S; fr < F; fr++) field.copyWithin(fr * F, edge, edge + F);
  }
  if (missing.has('west') || missing.has('east')) {
    for (let fr = 0; fr < F; fr++) {
      const row = fr * F;
      if (missing.has('west')) {
        for (let fc = 0; fc < M; fc++) field[row + fc] = field[row + M];
      }
      if (missing.has('east')) {
        for (let fc = M + S; fc < F; fc++) field[row + fc] = field[row + M + S - 1];
      }
    }
  }
}

function clampSlopeByte(v) {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return (v + 0.5) | 0;
}

// Résolution native : les cellules propres de la tuile, quantifiées.
function slopeFieldInterior(field) {
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const out = new Uint8Array(S * S);
  for (let r = 0; r < S; r++) {
    const src = (r + M) * F + M;
    const dst = r * S;
    for (let c = 0; c < S; c++) out[dst + c] = clampSlopeByte(field[src + c]);
  }
  return out;
}

// Catmull-Rom 2× séparable du champ encodé → (2S)² octets.
function upsampleSlopeField2x(field) {
  const S = DEM_TILE_SIZE;
  const M = SLOPE_FIELD_MARGIN;
  const F = S + 2 * M;
  const O = 2 * S;
  const [e0, e1, e2, e3] = SLOPE_CR_EVEN;
  const [o0, o1, o2, o3] = SLOPE_CR_ODD;

  const tmp = new Float32Array(F * O);
  for (let r = 0; r < F; r++) {
    const src = r * F + M;
    const dst = r * O;
    for (let i = 0; i < S; i++) {
      const s = src + i;
      tmp[dst + 2 * i] = e0 * field[s - 2] + e1 * field[s - 1] + e2 * field[s] + e3 * field[s + 1];
      tmp[dst + 2 * i + 1] = o0 * field[s - 1] + o1 * field[s] + o2 * field[s + 1] + o3 * field[s + 2];
    }
  }

  const out = new Uint8Array(O * O);
  for (let i = 0; i < S; i++) {
    const r = M + i;
    const rm2 = (r - 2) * O;
    const rm1 = (r - 1) * O;
    const r00 = r * O;
    const rp1 = (r + 1) * O;
    const rp2 = (r + 2) * O;
    const even = 2 * i * O;
    const odd = even + O;
    for (let c = 0; c < O; c++) {
      out[even + c] = clampSlopeByte(e0 * tmp[rm2 + c] + e1 * tmp[rm1 + c] + e2 * tmp[r00 + c] + e3 * tmp[rp1 + c]);
      out[odd + c] = clampSlopeByte(o0 * tmp[rm1 + c] + o1 * tmp[r00 + c] + o2 * tmp[rp1 + c] + o3 * tmp[rp2 + c]);
    }
  }
  return out;
}

// Repli au plus proche voisin pour le cas (théorique) de NoData : un
// échantillon Catmull-Rom sur une cellule NoData déverserait son gradient
// aberrant sur les pixels valides.
function upsampleBytesNearest(bytes, size, scale) {
  const O = size * scale;
  const out = new Uint8Array(O * O);
  for (let r = 0; r < O; r++) {
    const src = ((r / scale) | 0) * size;
    const dst = r * O;
    for (let c = 0; c < O; c++) out[dst + c] = bytes[src + ((c / scale) | 0)];
  }
  return out;
}

// Ancien mode `?res=N` : moyenne par blocs N×N de la pente native.
function blockAverageSlopeBytes(bytes, factor) {
  const S = DEM_TILE_SIZE;
  const out = new Uint8Array(S * S);
  for (let by = 0; by < S; by += factor) {
    const yEnd = Math.min(by + factor, S);
    for (let bx = 0; bx < S; bx += factor) {
      const xEnd = Math.min(bx + factor, S);
      let sum = 0;
      let n = 0;
      for (let yy = by; yy < yEnd; yy++) {
        for (let xx = bx; xx < xEnd; xx++) { sum += bytes[yy * S + xx]; n++; }
      }
      const avg = n > 0 ? Math.round(sum / n) : 0;
      for (let yy = by; yy < yEnd; yy++) out.fill(avg, yy * S + bx, yy * S + xEnd);
    }
  }
  return out;
}

// ── Masque par pixel de la zone d'analyse ─────────────────────────────
// Fonctions PURES (seulement mercatorTileBounds de geo.js) partagées par le
// scope du SW et le pool de workers, pour que les constructions du pool et du
// processus courant soient identiques à l'octet près.
//
// rasterizeRingMask projette l'anneau du polygone (paires [lng, lat]) dans
// l'espace des pixels de la tuile et le remplit par balayage de lignes avec un
// suréchantillonnage 2× ; le sous-échantillonnage par blocs 2×2 donne un bord
// adouci naturel d'environ 1 px, pour que la limite de la zone ne crénèle pas
// contre le maillage du terrain.

function rasterizeRingMask(ring, z, x, y, size) {
  const n = ring.length;
  if (!n || n < 3) return null;

  // 2× supersampled coverage buffer.
  const ss = 2;
  const sw = size * ss;
  const worldTiles = 1 << z;

  // Projette les sommets du polygone en coordonnées pixel Web Mercator dans l'espace [0, sw].
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lng = ring[i][0];
    const lat = ring[i][1];

    // X in Web Mercator tile pixel space
    const tileFracX = ((lng + 180) / 360) * worldTiles - x;
    px[i] = tileFracX * sw;

    // Y in Web Mercator tile pixel space
    const latRad = (lat * Math.PI) / 180;
    const sinLat = Math.sin(latRad);
    const clampedSin = Math.max(-0.999999, Math.min(0.999999, sinLat));
    const mercY = 0.5 * Math.log((1 + clampedSin) / (1 - clampedSin));
    const yFrac = 0.5 - mercY / (2 * Math.PI);
    const tileFracY = yFrac * worldTiles - y;
    py[i] = tileFracY * sw;
  }

  const mask = new Uint8Array(sw * sw);
  const xs = [];
  for (let row = 0; row < sw; row++) {
    const sy = row + 0.5;
    xs.length = 0;
    for (let e = 0; e < n; e++) {
      const i1 = (e + 1) % n;
      const y0 = py[e];
      const y1 = py[i1];
      if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
        const t = (sy - y0) / (y1 - y0);
        xs.push(px[e] + t * (px[i1] - px[e]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, c) => a - c);
    const rowBase = row * sw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cx0 = Math.max(0, Math.ceil(xs[k]));
      const cx1 = Math.min(sw - 1, Math.floor(xs[k + 1]));
      for (let cx = cx0; cx <= cx1; cx++) {
        mask[rowBase + cx] = 255;
      }
    }
  }

  // 2×2 average downsample → feathered alpha.
  const out = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    const sRow = r * ss * sw;
    const oRow = r * size;
    for (let c = 0; c < size; c++) {
      const s0 = sRow + c * ss;
      out[oRow + c] = (mask[s0] + mask[s0 + 1] + mask[s0 + sw] + mask[s0 + sw + 1]) >> 2;
    }
  }
  return out;
}

// Multiplie le canal alpha RGBA par le masque (0 → entièrement transparent,
// 255 → inchangé). Le RGB est laissé tel quel : le raster-color côté GPU ne lit
// que les pixels d'alpha > 0 (le mélange alpha bilinéaire gère l'adoucissement).
function applyRingMaskToRgba(rgba, mask) {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m >= 255) continue;
    const idx = j * 4;
    if (m === 0) {
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
      rgba[idx + 3] = 0;
    } else {
      rgba[idx + 3] = ((rgba[idx + 3] * m) + 127) >> 8;
    }
  }
}

// Comme applyRingMaskToRgba, pour un plan alpha séparé.
function applyRingMaskToAlpha(alpha, mask) {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m < 255) alpha[j] = ((alpha[j] * m) + 127) >> 8;
  }
}

// ── Orchestrateur ─────────────────────────────────────────────────────
// Altitudes propres + altitudes voisines déjà décodées en entrée, PNG en sortie.
// C'est la seule fonction qu'appellent le pool de workers et le repli dans le
// processus courant.
//
//   options.outputScale  1 = résolution native du DEM (tuiles de zone),
//                        2 = Catmull-Rom 2× (tuiles alignées sur le terrain)
//   options.resFactor    ancienne moyenne par blocs `?res=N` (sortie native)
//   options.zoneRing     anneau optionnel [[lng, lat], …] de la zone d'analyse
//
// Renvoie { blob: Blob (PNG gris ou gris + alpha), missingDirections: string[] }.
async function buildSlopePngFromElevations(ownElev, neighbourElevations, z, x, y, options = {}) {
  const S = DEM_TILE_SIZE;
  const resFactor = Number(options.resFactor) > 1 ? Math.min(64, Number(options.resFactor) | 0) : 1;
  const outputScale = resFactor > 1 ? 1 : (Number(options.outputScale) >= 2 ? 2 : 1);

  const { pad, missingDirections } = buildPaddedElevationsFromArrays(ownElev, neighbourElevations);
  const field = computeSlopeField(pad, z, y);
  replicateMissingSlopeMargins(field, missingDirections);

  let noData = null;
  for (let j = 0; j < S * S; j++) {
    if (ownElev[j] <= DEM_NODATA_THRESHOLD) {
      if (!noData) noData = new Uint8Array(S * S);
      noData[j] = 1;
    }
  }

  let gray;
  if (resFactor > 1) {
    gray = blockAverageSlopeBytes(slopeFieldInterior(field), resFactor);
  } else if (outputScale === 2) {
    gray = noData
      ? upsampleBytesNearest(slopeFieldInterior(field), S, 2)
      : upsampleSlopeField2x(field);
  } else {
    gray = slopeFieldInterior(field);
  }

  const size = S * outputScale;
  const zoneMask = options.zoneRing ? rasterizeRingMask(options.zoneRing, z, x, y, size) : null;
  // La tuile habituelle est entièrement opaque : PNG gris seul (moitié moins d'octets à compresser).
  if (!noData && !zoneMask) {
    return { blob: await buildGrayPng(size, size, gray), missingDirections };
  }

  const alpha = new Uint8Array(size * size).fill(255);
  if (noData) {
    const mask = outputScale === 2 ? upsampleBytesNearest(noData, S, 2) : noData;
    for (let j = 0; j < alpha.length; j++) {
      if (mask[j]) { alpha[j] = 0; gray[j] = 0; }
    }
  }
  if (zoneMask) applyRingMaskToAlpha(alpha, zoneMask);

  const blob = await buildGrayAlphaPng(size, size, gray, alpha);
  return { blob, missingDirections };
}
