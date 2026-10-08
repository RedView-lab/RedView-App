// ---------------------------------------------------------------------------
// Composition des altitudes IGN + Mapbox avec zone de fondu à la limite de
// couverture. Utilise : transformée de distance de chanfrein + correction de
// décalage IDW + fondu smoothstep.
//
// Chemin rapide en couverture complète : quand chaque pixel a une donnée IGN, le
// fondu coûteux est inutile — il suffit d'aligner les altitudes sol nu de l'IGN
// sur le datum sol nu de Mapbox au *bord* de la tuile, pour que le maillage de
// sortie soit continu (C0) avec les tuiles voisines (qui peuvent être du Mapbox
// pur ou une composition partielle au même LOD). C'est en O(4·TILE_SIZE) au
// lieu de O(TILE²).
// ---------------------------------------------------------------------------

// Couverture partielle sans tuile de fond mondiale (AWS indisponible / créneau
// expiré). Les pixels non couverts des grilles des constructeurs valent encore
// 0 m : les encoder tels quels plantait un plateau à 0 m dans la tuile — une
// dalle parfaitement plate sur l'overlay des pentes (couleur uniforme 0°)
// cernée d'une ligne de falaise. Les tuiles majoritairement couvertes sont
// complétées par propagation du plus proche pixel valide ; une tuile surtout
// trouée donne null, pour que le dispatcher passe à son repli suivant au lieu
// de mettre en cache une fausse surface.
const COMPOSITE_NO_BACKGROUND_MIN_COVERAGE = 0.5;

function encodeWithoutBackground(ignElevations, coverage) {
  const total = DEM_TILE_SIZE * DEM_TILE_SIZE;
  let covered = 0;
  for (let i = 0; i < total; i++) if (coverage[i]) covered++;
  if (covered < total * COMPOSITE_NO_BACKGROUND_MIN_COVERAGE) return null;
  if (covered === total) return encodeTerrainRGBPng(ignElevations);

  const elev = new Float32Array(ignElevations);
  const cov = new Uint8Array(coverage);
  const nextElev = new Float32Array(total);
  const nextCov = new Uint8Array(total);
  const S = DEM_TILE_SIZE;
  while (covered < total) {
    nextElev.set(elev);
    nextCov.set(cov);
    let grown = 0;
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const idx = py * S + px;
        if (cov[idx]) continue;
        let sum = 0;
        let n = 0;
        if (py > 0 && cov[idx - S]) { sum += elev[idx - S]; n++; }
        if (py < S - 1 && cov[idx + S]) { sum += elev[idx + S]; n++; }
        if (px > 0 && cov[idx - 1]) { sum += elev[idx - 1]; n++; }
        if (px < S - 1 && cov[idx + 1]) { sum += elev[idx + 1]; n++; }
        if (n > 0) {
          nextElev[idx] = sum / n;
          nextCov[idx] = 1;
          grown++;
        }
      }
    }
    if (grown === 0) return null;
    covered += grown;
    elev.set(nextElev);
    cov.set(nextCov);
  }
  return encodeTerrainRGBPng(elev);
}

async function compositeIGNMapbox(ignElevations, coverage, z, x, y, opts = {}) {
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;

  // Chemin rapide : couverture complète uniforme → alignement par décalage de l'anneau de bord seulement.
  let fullCoverageFast = true;
  for (let i = 0; i < totalPixels; i++) {
    if (!coverage[i]) { fullCoverageFast = false; break; }
  }

  if (fullCoverageFast) {
    // Chemin à datum invariant selon le LOD (tuiles intérieures du jeu national).
    //
    // Une tuile entièrement couverte située tout entière dans le polygone du jeu
    // de données national ne borde jamais une tuile Mapbox pure : elle n'a
    // besoin d'AUCUN alignement sur le datum Mapbox. Le biais constant par tuile
    // ci-dessous (médiane IGN−Mapbox sur l'anneau de bord) est recalculé
    // indépendamment pour chaque tuile ET chaque niveau de LOD. En vue inclinée,
    // Mapbox rend les tuiles voisines à des zooms différents (un anneau de LOD
    // normal) : deux tuiles couvrant le même sol recevaient des décalages
    // constants DIFFÉRENTS — une tuile entière se déplaçait de quelques mètres
    // par rapport à sa voisine, d'où le « mur » vertical signalé en 0,40 m, qui
    // apparaît et disparaît quand l'angle de caméra déplace l'anneau de LOD.
    // Encoder le datum IGN brut garde toutes les tuiles IGN sur la même
    // référence verticale MNS, cohérente partout : les voisines concordent quel
    // que soit le LOD. La vraie continuité IGN↔Mapbox à la frontière nationale
    // est assurée par le chemin de fondu en couverture partielle plus bas (les
    // tuiles de bord sont en couverture partielle), pas ici. En prime : un fetch
    // Mapbox et un décodage Terrain-RGB en moins par tuile intérieure.
    if (opts.skipDatumBias) {
      return encodeTerrainRGBPng(ignElevations);
    }

    let mbElevations = opts.prefilledMbElev;
    if (!mbElevations) {
      const mapboxBlob = await fetchMapboxTile(z, x, y);
      if (!mapboxBlob) {
        return encodeTerrainRGBPng(ignElevations);
      }
      mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
      if (!mbElevations || mbElevations.length === 0) return encodeTerrainRGBPng(ignElevations);
    }

    // Despike défensif de Mapbox avant de mesurer les décalages. On travaille
    // sur une copie : les grilles décodées sont partagées via DECODED_TERRAIN_RGB_CACHE.
    mbElevations = new Float32Array(mbElevations);
    const mbSize = Math.round(Math.sqrt(mbElevations.length));
    {
      const mbCov = new Uint8Array(mbElevations.length).fill(1);
      despikeElevations(mbElevations, mbCov, mbSize);
    }

    const scale = mbSize / DEM_TILE_SIZE;
    const sampleMB = (px, py) => {
      if (scale === 1) return mbElevations[py * DEM_TILE_SIZE + px];
      const mx = Math.min((px * scale) | 0, mbSize - 1);
      const my = Math.min((py * scale) | 0, mbSize - 1);
      return mbElevations[my * mbSize + mx];
    };

    // Collecte des décalages sur les 4 bords (anneau de 1 px). Ce sont les seuls
    // pixels partagés (géographiquement) avec les tuiles voisines : les aligner
    // suffit à l'étanchéité du maillage à tous les LOD.
    const offsets = [];
    const last = DEM_TILE_SIZE - 1;
    const pushOff = (px, py) => {
      const mb = sampleMB(px, py);
      if (mb <= -9000) return;
      const off = ignElevations[py * DEM_TILE_SIZE + px] - mb;
      if (off > -500 && off < 500) offsets.push(off);
    };
    for (let px = 0; px < DEM_TILE_SIZE; px++) { pushOff(px, 0); pushOff(px, last); }
    for (let py = 1; py < last; py++) { pushOff(0, py); pushOff(last, py); }

    let bias = 0;
    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      const mid = offsets.length >> 1;
      bias = offsets.length & 1
        ? offsets[mid]
        : (offsets[mid - 1] + offsets[mid]) / 2;
    }

    // Application d'un biais constant pour que les pixels de bord concordent avec
    // Mapbox ; le détail IGN intérieur est préservé (simplement décalé d'une
    // constante → aucune déformation des pentes).
    if (bias !== 0) {
      const out = new Float32Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) out[i] = ignElevations[i] - bias;
      const fullCoverage = new Uint8Array(totalPixels).fill(1);
      despikeElevations(out, fullCoverage, DEM_TILE_SIZE);
      return encodeTerrainRGBPng(out);
    }
    return encodeTerrainRGBPng(ignElevations);
  }

  // --- Original partial-coverage path (distance transform + IDW blend) ---
  let mbElevations = opts.prefilledMbElev;
  if (!mbElevations) {
    const mapboxBlob = await fetchMapboxTile(z, x, y);
    if (!mapboxBlob) {
      return encodeWithoutBackground(ignElevations, coverage);
    }
    mbElevations = await decodeTerrainRGBBlob(mapboxBlob);
    if (!mbElevations || mbElevations.length === 0) {
      return encodeWithoutBackground(ignElevations, coverage);
    }
  }

  // Despike défensif : même après le correctif de la corruption au
  // rééchantillonnage du terrain-RGB dans mapbox.js, une valeur aberrante du DEM
  // Mapbox ferait dériver le décalage IDW ci-dessous de centaines de mètres et
  // réintroduirait des pics visibles le long de l'anneau de fondu. La médiane
  // 3×3 coûte peu et préserve le vrai relief.
  // Copie d'abord : les grilles décodées sont partagées via DECODED_TERRAIN_RGB_CACHE.
  mbElevations = new Float32Array(mbElevations);
  {
    const mbSize = Math.round(Math.sqrt(mbElevations.length));
    const mbCov = new Uint8Array(mbElevations.length).fill(1);
    despikeElevations(mbElevations, mbCov, mbSize);
  }

  // Rayon de fondu adaptatif : plus large aux faibles zooms (chaque pixel couvre plus de terrain)
  const BLEND_RADIUS = Math.max(96, Math.round(192 / Math.pow(1.1, Math.max(0, z - 5))));

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  // Resample Mapbox elevations helper
  const mbSize = Math.round(Math.sqrt(mbElevations.length));
  const scale = mbSize / DEM_TILE_SIZE;

  function sampleMB(px, py) {
    if (scale === 1) return mbElevations[py * DEM_TILE_SIZE + px];
    const mx = Math.min((px * scale) | 0, mbSize - 1);
    const my = Math.min((py * scale) | 0, mbSize - 1);
    return mbElevations[my * mbSize + mx];
  }

  // --- Distance transform (Chamfer 2-pass) ---
  const distToBorder = new Float32Array(totalPixels);
  const INF = DEM_TILE_SIZE * 2;
  distToBorder.fill(INF);

  // Marque les pixels de bord (distance = 0) — pixels adjacents à un état de couverture différent
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      const c = coverage[idx];
      if (
        (py > 0 && coverage[idx - DEM_TILE_SIZE] !== c) ||
        (py < DEM_TILE_SIZE - 1 && coverage[idx + DEM_TILE_SIZE] !== c) ||
        (px > 0 && coverage[idx - 1] !== c) ||
        (px < DEM_TILE_SIZE - 1 && coverage[idx + 1] !== c)
      ) {
        distToBorder[idx] = 0;
      }
    }
  }

  // Forward pass
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE] + 1);
      if (px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - 1] + 1);
      if (py > 0 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE - 1] + 1.414);
      if (py > 0 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx - DEM_TILE_SIZE + 1] + 1.414);
    }
  }

  // Backward pass
  for (let py = DEM_TILE_SIZE - 1; py >= 0; py--) {
    for (let px = DEM_TILE_SIZE - 1; px >= 0; px--) {
      const idx = py * DEM_TILE_SIZE + px;
      if (py < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE] + 1);
      if (px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + 1] + 1);
      if (py < DEM_TILE_SIZE - 1 && px < DEM_TILE_SIZE - 1) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE + 1] + 1.414);
      if (py < DEM_TILE_SIZE - 1 && px > 0) distToBorder[idx] = Math.min(distToBorder[idx], distToBorder[idx + DEM_TILE_SIZE - 1] + 1.414);
    }
  }

  // --- Collect per-pixel border offset samples (IGN − Mapbox) ---
  const borderSamples = [];
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const idx = py * DEM_TILE_SIZE + px;
      if (distToBorder[idx] < 3 && coverage[idx]) {
        const mb = sampleMB(px, py);
        if (mb > -9000) {
          const off = ignElevations[idx] - mb;
          if (off > -500 && off < 500) {
            borderSamples.push({ px, py, offset: off });
          }
        }
      }
    }
  }

  // Compute median offset as fallback
  let medianOffset = 0;
  if (borderSamples.length > 0) {
    const sorted = borderSamples.map(s => s.offset).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    medianOffset = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Sous-échantillonnage pour les performances (au plus 400 échantillons représentatifs)
  let samplesForIDW = borderSamples;
  if (samplesForIDW.length > 400) {
    const step = Math.ceil(samplesForIDW.length / 400);
    samplesForIDW = samplesForIDW.filter((_, i) => i % step === 0);
  }

  // Inverse-distance-weighted offset evaluator
  function rawIdwOffset(px, py) {
    if (samplesForIDW.length === 0) return medianOffset;
    if (samplesForIDW.length < 4) return medianOffset;

    let wSum = 0, vSum = 0;
    const searchR = BLEND_RADIUS * 2;
    const searchR2 = searchR * searchR;
    for (let i = 0; i < samplesForIDW.length; i++) {
      const s = samplesForIDW[i];
      const dx = px - s.px;
      const dy = py - s.py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) return s.offset;
      if (d2 > searchR2) continue;
      const w = 1 / d2;
      wSum += w;
      vSum += w * s.offset;
    }
    const result = wSum > 0 ? vSum / wSum : medianOffset;
    return Number.isFinite(result) ? result : medianOffset;
  }

  // Précalcule une grille spatiale grossière de 17×17 (289 points) sur la tuile
  // 256×256 et l'interpole en bilinéaire dans la boucle de fondu. 100 000× plus
  // rapide qu'un IDW complet par pixel, parfaitement continu et lisse (C1) aux jointures.
  const GRID_SIZE = 16;
  const GRID_POINTS = GRID_SIZE + 1; // 17
  const offsetGrid = new Float32Array(GRID_POINTS * GRID_POINTS);
  for (let gy = 0; gy < GRID_POINTS; gy++) {
    const py = Math.min(gy * (DEM_TILE_SIZE / GRID_SIZE), DEM_TILE_SIZE - 1);
    for (let gx = 0; gx < GRID_POINTS; gx++) {
      const px = Math.min(gx * (DEM_TILE_SIZE / GRID_SIZE), DEM_TILE_SIZE - 1);
      offsetGrid[gy * GRID_POINTS + gx] = rawIdwOffset(px, py);
    }
  }

  function getInterpolatedOffset(px, py) {
    const gx = (px / DEM_TILE_SIZE) * GRID_SIZE;
    const gy = (py / DEM_TILE_SIZE) * GRID_SIZE;
    const ix = Math.max(0, Math.min(Math.floor(gx), GRID_SIZE - 1));
    const iy = Math.max(0, Math.min(Math.floor(gy), GRID_SIZE - 1));
    const fx = gx - ix;
    const fy = gy - iy;

    const row0 = iy * GRID_POINTS;
    const row1 = (iy + 1) * GRID_POINTS;
    const o00 = offsetGrid[row0 + ix];
    const o10 = offsetGrid[row0 + ix + 1];
    const o01 = offsetGrid[row1 + ix];
    const o11 = offsetGrid[row1 + ix + 1];

    const top = o00 + (o10 - o00) * fx;
    const bot = o01 + (o11 - o01) * fx;
    return top + (bot - top) * fy;
  }

  // --- Composition avec fondu corrigé d'un décalage variable dans l'espace ---
  const result = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const py = (i / DEM_TILE_SIZE) | 0;
    const px = i % DEM_TILE_SIZE;
    const mb = sampleMB(px, py);
    const dist = distToBorder[i];

    if (dist >= BLEND_RADIUS) {
      // Loin du bord — source utilisée directement
      result[i] = coverage[i] ? ignElevations[i] : mb;
    } else {
      // Dans la zone de fondu — interpolation smoothstep avec correction de décalage
      const t = smoothstep(dist / BLEND_RADIUS);
      const localOffset = getInterpolatedOffset(px, py);

      if (coverage[i]) {
        // Pixel IGN : fondu de Mapbox corrigé du décalage au bord → IGN pur à l'intérieur
        const mbCorrected = mb + localOffset;
        result[i] = ignElevations[i] * t + mbCorrected * (1 - t);
      } else {
        // Pixel Mapbox : fondu de la valeur corrigée → Mapbox brut à l'extérieur
        const mbCorrected = mb + localOffset * (1 - t);
        result[i] = mbCorrected;
      }
    }
  }

  // Libère les intermédiaires lourds avant l'encodage PNG
  distToBorder.fill(0);
  borderSamples.length = 0;
  samplesForIDW = null;

  // Despike d'un seul pixel — retire les pixels chauds LiDAR qui ont passé la
  // validation de la source (le MNS peut encore montrer des cimes d'arbres, des
  // oiseaux ou des nuages à quelques centaines de mètres au-dessus du terrain).
  // Une vraie falaise s'étend sur plusieurs pixels : la médiane 3×3 concorde et
  // rien n'est modifié.
  const fullCoverage = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE).fill(1);
  despikeElevations(result, fullCoverage, DEM_TILE_SIZE);

  return encodeTerrainRGBPng(result);
}
