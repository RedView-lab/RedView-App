// ---------------------------------------------------------------------------
// Espagne — construction d'une tuile DEM Mercator depuis le WCS MDT INSPIRE de l'IGN / IDEE
// ---------------------------------------------------------------------------

const SPAIN_PRUNED_SENTINEL = Object.freeze({ _spainPruned: true });
const T_StripOffsets = 273;
const T_RowsPerStrip = 278;
const T_StripByteCounts = 279;

let _spainActive = 0;
const _spainQueue = [];

function spainScheduleFetch(fn) {
  return new Promise((resolve, reject) => {
    _spainQueue.push({ fn, resolve, reject, ts: performance.now() });
    while (_spainQueue.length > SPAIN_QUEUE_MAX) {
      let oldestIdx = 0;
      let oldestTs = _spainQueue[0].ts;
      for (let i = 1; i < _spainQueue.length; i++) {
        if (_spainQueue[i].ts < oldestTs) {
          oldestTs = _spainQueue[i].ts;
          oldestIdx = i;
        }
      }
      const stale = _spainQueue.splice(oldestIdx, 1)[0];
      stale.resolve(SPAIN_PRUNED_SENTINEL);
    }
    drainSpainQueue();
  });
}

function drainSpainQueue() {
  while (_spainActive < SPAIN_CONCURRENCY && _spainQueue.length > 0) {
    // FIFO : on prend la tâche en file la plus ANCIENNE. L'ancien `pop()` LIFO
    // faisait toujours passer la requête de tuile la plus récente avant les
    // plus anciennes : traverser les Pyrénées créait un blocage en tête de file
    // où les premières tuiles de la vue étaient sans cesse repoussées puis
    // élaguées en PRUNED_SENTINEL — visible comme un « chargement bloqué à 1 % »
    // sur la pastille pente / altitude.
    const { fn, resolve, reject } = _spainQueue.shift();
    _spainActive++;
    fn().then(resolve).catch(reject).finally(() => {
      _spainActive--;
      drainSpainQueue();
    });
  }
}

// Reprojette le raster source du WCS (aligné sur les axes du CRS UTM natif de la
// couverture) sur la grille de pixels de la tuile Mercator. Deux régimes :
//
//   (A) Pas source ≤ pas destination → MOYENNE PAR BLOCS pondérée par la surface.
//       Pour chaque pixel Mercator de sortie, on projette les 4 coins en UTM, on
//       calcule la bbox en pixels source de cette empreinte et on moyenne tous
//       les pixels source qu'elle contient (poids fractionnaires sur les pixels
//       de bord). C'est un rééchantillonnage exact par surface, et c'est ce qui
//       supprime l'artefact de moiré / grille que produit le bilinéaire ponctuel
//       sur les overlays de pente / altitude quand le pas de la grille source
//       est comparable au pas de destination — même cause que le correctif du
//       WMS France du 3 mai, où une surface à 0,40 m demandée en sortie à 1 m
//       produisait des bandes horizontales régulières ; le remède y était un
//       suréchantillonnage 2× + moyenne par blocs dans getTerrainWmsTile.
//
//   (B) Pas source > pas destination (zoom au-delà de la résolution source) →
//       repli sur le bilinéaire pondéré par la couverture, l'interpolant optimal
//       quand la source est la bande limitante.
//
// La reprojection par pixel (au lieu de copier le raster UTM comme s'il était
// aligné sur Mercator) est aussi ce qui supprime les jointures entre tuiles :
// des tuiles Mercator voisines récupèrent des bbox UTM DIFFÉRENTES, et la seule
// façon pour deux tuiles de concorder le long de leur bord commun est
// d'échantillonner aux mêmes (lng, lat).
function _resampleSpainSourceToMercator(
  srcElev, srcCov, srcW, srcH, bounds, mercZ, mercX, mercY, utmZone,
) {
  const outElev = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const outCov = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const n = 1 << mercZ;
  const dE = bounds.maxE - bounds.minE;
  const dN = bounds.maxN - bounds.minN;
  if (!(dE > 0) || !(dN > 0)) return { elevations: outElev, coverage: outCov };

  const invDE = 1 / dE;
  const invDN = 1 / dN;

  // Précalcule les coordonnées en pixels source de chaque COIN de chaque pixel
  // de sortie (DEM_TILE_SIZE+1 coins par axe). Chaque pixel réutilise ainsi les
  // quatre coins stockés dans fX/fY (espace des pixels source) au lieu de
  // reprojeter quatre points (lng, lat) → UTM par pixel de sortie — économise
  // ~3× le travail de projection, qui domine le coût du rééchantillonnage.
  const C = DEM_TILE_SIZE + 1;
  const fX = new Float32Array(C * C);
  const fY = new Float32Array(C * C);
  for (let cy = 0; cy < C; cy++) {
    const yFrac = (mercY + cy / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);
    for (let cx = 0; cx < C; cx++) {
      const xFrac = (mercX + cx / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;
      const p = wgs84ToSpainProjected(lng, lat, utmZone);
      // Coordonnées en pixels source (ligne TIFF 0 = nord) — attention, c'est
      // l'espace des COINS de pixels source (pas des centres), celui qu'il faut
      // pour la moyenne par blocs : 0 signifie « bord gauche de la colonne 0 ».
      fX[cy * C + cx] = (p.E - bounds.minE) * invDE * srcW;
      fY[cy * C + cx] = (bounds.maxN - p.N) * invDN * srcH;
    }
  }

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const c00 = py * C + px;
      const c10 = c00 + 1;
      const c01 = c00 + C;
      const c11 = c01 + 1;
      const x00 = fX[c00], y00 = fY[c00];
      const x10 = fX[c10], y10 = fY[c10];
      const x01 = fX[c01], y01 = fY[c01];
      const x11 = fX[c11], y11 = fY[c11];

      // Bbox source de l'empreinte du pixel de destination.
      let sxMin = x00; if (x10 < sxMin) sxMin = x10; if (x01 < sxMin) sxMin = x01; if (x11 < sxMin) sxMin = x11;
      let sxMax = x00; if (x10 > sxMax) sxMax = x10; if (x01 > sxMax) sxMax = x01; if (x11 > sxMax) sxMax = x11;
      let syMin = y00; if (y10 < syMin) syMin = y10; if (y01 < syMin) syMin = y01; if (y11 < syMin) syMin = y11;
      let syMax = y00; if (y10 > syMax) syMax = y10; if (y01 > syMax) syMax = y01; if (y11 > syMax) syMax = y11;

      const dstIdx = py * DEM_TILE_SIZE + px;

      // Découpe au raster source.
      if (sxMax <= 0 || syMax <= 0 || sxMin >= srcW || syMin >= srcH) continue;
      if (sxMin < 0) sxMin = 0;
      if (syMin < 0) syMin = 0;
      if (sxMax > srcW) sxMax = srcW;
      if (syMax > srcH) syMax = srcH;

      const fwX = sxMax - sxMin;
      const fwY = syMax - syMin;

      // Régime B — le pixel de destination couvre moins d'un pixel source entier
      // (≈ < 1 sur l'un des axes) : bilinéaire ponctuel au centroïde des quatre
      // coins. Moyenner par blocs une surface inférieure au pixel reviendrait à
      // une seule valeur source et réintroduirait l'escalier du plus proche voisin.
      if (fwX < 1 && fwY < 1) {
        const fx = ((x00 + x10 + x01 + x11) * 0.25) - 0.5;
        const fy = ((y00 + y10 + y01 + y11) * 0.25) - 0.5;
        const ix0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
        const iy0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
        const ix1 = Math.max(0, Math.min(srcW - 1, ix0 + 1));
        const iy1 = Math.max(0, Math.min(srcH - 1, iy0 + 1));
        const tx = Math.max(0, Math.min(1, fx - Math.floor(fx)));
        const ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));
        const i00 = iy0 * srcW + ix0;
        const i10 = iy0 * srcW + ix1;
        const i01 = iy1 * srcW + ix0;
        const i11 = iy1 * srcW + ix1;
        const k00 = srcCov[i00];
        const k10 = srcCov[i10];
        const k01 = srcCov[i01];
        const k11 = srcCov[i11];
        let sum = 0;
        let w = 0;
        if (k00) { const wt = (1 - tx) * (1 - ty); sum += srcElev[i00] * wt; w += wt; }
        if (k10) { const wt = tx * (1 - ty);       sum += srcElev[i10] * wt; w += wt; }
        if (k01) { const wt = (1 - tx) * ty;       sum += srcElev[i01] * wt; w += wt; }
        if (k11) { const wt = tx * ty;             sum += srcElev[i11] * wt; w += wt; }
        if (w > 0) { outElev[dstIdx] = sum / w; outCov[dstIdx] = 1; }
        continue;
      }

      // Régime A — moyenne par blocs pondérée par la surface sur l'empreinte
      // source. On parcourt chaque pixel source touché par [sxMin..sxMax] ×
      // [syMin..syMax] et on le pondère par la surface de son recouvrement avec
      // la bbox source du pixel de destination.
      const ix0 = Math.floor(sxMin);
      const iy0 = Math.floor(syMin);
      const ix1 = Math.min(srcW - 1, Math.ceil(sxMax) - 1);
      const iy1 = Math.min(srcH - 1, Math.ceil(syMax) - 1);
      let sum = 0;
      let wSum = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const cellTop = iy;
        const cellBot = iy + 1;
        const dy = Math.min(syMax, cellBot) - Math.max(syMin, cellTop);
        if (dy <= 0) continue;
        const rowBase = iy * srcW;
        for (let ix = ix0; ix <= ix1; ix++) {
          const cellL = ix;
          const cellR = ix + 1;
          const dx = Math.min(sxMax, cellR) - Math.max(sxMin, cellL);
          if (dx <= 0) continue;
          const idx = rowBase + ix;
          if (!srcCov[idx]) continue;
          const w = dx * dy;
          sum += srcElev[idx] * w;
          wSum += w;
        }
      }
      if (wSum > 0) {
        outElev[dstIdx] = sum / wSum;
        outCov[dstIdx] = 1;
      }
    }
  }
  return { elevations: outElev, coverage: outCov };
}

function fillSpainCoverage(elevations, coverage, size) {
  const W = size || DEM_TILE_SIZE;
  let coveredCount = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i]) coveredCount++;
  if (coveredCount === 0 || coveredCount === coverage.length) return coveredCount;

  for (let pass = 0; pass < 3; pass++) {
    const nextElevations = new Float32Array(elevations);
    const nextCoverage = new Uint8Array(coverage);
    let passChanged = false;
    for (let py = 0; py < W; py++) {
      for (let px = 0; px < W; px++) {
        const idx = py * W + px;
        if (coverage[idx]) continue;
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = py + oy;
          if (ny < 0 || ny >= W) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = px + ox;
            if ((ox === 0 && oy === 0) || nx < 0 || nx >= W) continue;
            const nIdx = ny * W + nx;
            if (!coverage[nIdx]) continue;
            sum += elevations[nIdx];
            count++;
          }
        }
        if (count > 0) {
          nextElevations[idx] = sum / count;
          nextCoverage[idx] = 1;
          coveredCount++;
          passChanged = true;
        }
      }
    }
    elevations.set(nextElevations);
    coverage.set(nextCoverage);
    if (!passChanged) break;
  }

  return coveredCount;
}

// Passe-bas préservant les arêtes pour le raster MDT5 quantifié en Int16. Le
// MDT5 stocke les altitudes en mètres entiers : les pentes douces (≤ ~15°)
// présentent des courbes en « escalier » de 1 m une fois triangulées par le
// terrain Mapbox — elles se lisent comme des micro-ondulations parallèles aux
// courbes de niveau sur les surfaces de neige / pâturage en 3D. Une moyenne
// pondérée 3×3 (centre 4 / bords 2 / coins 1, gain 16), appliquée seulement là
// où l'écart d'altitude local 3×3 est < SPAIN_SMOOTH_VARIANCE_M, supprime les
// marches sans adoucir les vraies falaises / crêtes (qui dépassent toutes le
// seuil par définition).
function smoothSpainQuantization(elevations, coverage, width, height) {
  const W = width;
  const H = height || width;
  const out = new Float32Array(elevations);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      if (!coverage[idx]) continue;
      const i_n  = idx - W;
      const i_s  = idx + W;
      const i_w  = idx - 1;
      const i_e  = idx + 1;
      const i_nw = i_n - 1;
      const i_ne = i_n + 1;
      const i_sw = i_s - 1;
      const i_se = i_s + 1;
      if (!(coverage[i_n] && coverage[i_s] && coverage[i_w] && coverage[i_e]
            && coverage[i_nw] && coverage[i_ne] && coverage[i_sw] && coverage[i_se])) continue;
      const c  = elevations[idx];
      const vn = elevations[i_n];
      const vs = elevations[i_s];
      const vw = elevations[i_w];
      const ve = elevations[i_e];
      const vnw = elevations[i_nw];
      const vne = elevations[i_ne];
      const vsw = elevations[i_sw];
      const vse = elevations[i_se];
      let mn = c, mx = c;
      if (vn < mn) mn = vn; if (vn > mx) mx = vn;
      if (vs < mn) mn = vs; if (vs > mx) mx = vs;
      if (vw < mn) mn = vw; if (vw > mx) mx = vw;
      if (ve < mn) mn = ve; if (ve > mx) mx = ve;
      if (vnw < mn) mn = vnw; if (vnw > mx) mx = vnw;
      if (vne < mn) mn = vne; if (vne > mx) mx = vne;
      if (vsw < mn) mn = vsw; if (vsw > mx) mx = vsw;
      if (vse < mn) mn = vse; if (vse > mx) mx = vse;
      if (mx - mn > SPAIN_SMOOTH_VARIANCE_M) continue; // bord / falaise — préservé
      out[idx] = (vnw + 2 * vn + vne + 2 * vw + 4 * c + 2 * ve + vsw + 2 * vs + vse) / 16;
    }
  }
  elevations.set(out);
}

function buildSpainWCSUrl(coverage, bounds, outW, outH) {
  // scaleSize est PLAFONNÉ à l'emprise native du MDT5 (≈ étendue_m / 5 m).
  //
  // Demander au serveur PLUS de pixels que sa résolution native lui fait
  // SURÉCHANTILLONNER en bilinéaire son raster Int16 (quantifié au mètre) — des
  // lignes voisines se retrouvent avec des valeurs identiques, puis Horn 3×3
  // dans slope.js transforme cette duplication en bandes horizontales
  // régulières, visibles sur les tuiles z14+ d'Andalousie / des Pyrénées.
  // Plafonner au natif garde la grille de 5 m une grille de 5 m ; notre
  // rééchantillonneur client pondéré par la surface produit alors les seules
  // valeurs sous-pixel légitimes, par moyenne des voisins, au lieu d'une
  // duplication de lignes côté serveur.
  //
  // Demander MOINS de pixels que le natif à faible zoom est correct et économe
  // en bande passante (la moyenne par blocs du serveur convient à un
  // sous-échantillonnage strict).
  return 'https://servicios.idee.es/wcs-inspire/mdt'
    + `?service=WCS`
    + `&version=${SPAIN_WCS_VERSION}`
    + `&request=GetCoverage`
    + `&coverageId=${encodeURIComponent(coverage.coverageId)}`
    + `&format=${encodeURIComponent(SPAIN_WCS_FORMAT)}`
    + `&subset=x(${bounds.minE},${bounds.maxE})`
    + `&subset=y(${bounds.minN},${bounds.maxN})`
    + `&scaleSize=x(${outW}),y(${outH})`;
}

async function parseSpainGeoTIFF(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 16) throw new Error('TIFF buffer too short');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = view.getUint16(0, true);
  let littleEndian;
  if (byteOrder === 0x4949) littleEndian = true;
  else if (byteOrder === 0x4D4D) littleEndian = false;
  else throw new Error('not a TIFF');

  const magic = view.getUint16(2, littleEndian);
  if (magic !== 42) throw new Error(`unsupported TIFF magic ${magic}`);

  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const tags = new Map();
  for (let i = 0; i < entryCount; i++) {
    const entryOff = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOff, littleEndian);
    const type = view.getUint16(entryOff + 2, littleEndian);
    const count = view.getUint32(entryOff + 4, littleEndian);
    tags.set(tag, { entryOff, type, count });
  }

  const readTag = (tagId) => {
    const tag = tags.get(tagId);
    if (!tag) return null;
    return readTagValue(view, tag.entryOff, tag.type, tag.count, littleEndian, bytes);
  };

  const width = readTag(T_ImageWidth)?.[0] ?? 0;
  const height = readTag(T_ImageLength)?.[0] ?? 0;
  const bitsPerSample = readTag(T_BitsPerSample)?.[0] ?? 0;
  const compression = readTag(T_Compression)?.[0] ?? 1;
  const samplesPerPixel = readTag(T_SamplesPerPixel)?.[0] ?? 1;
  const sampleFormat = readTag(T_SampleFormat)?.[0] ?? 1;
  const stripOffsets = readTag(T_StripOffsets);
  const rowsPerStrip = readTag(T_RowsPerStrip)?.[0] ?? 0;
  const stripByteCounts = readTag(T_StripByteCounts);
  const nodataTag = readTag(T_GDAL_NODATA);

  if (!width || !height) throw new Error('missing TIFF dimensions');
  if (!stripOffsets || !stripByteCounts || !rowsPerStrip) throw new Error('missing TIFF strips');
  if (samplesPerPixel !== 1) throw new Error(`unsupported samplesPerPixel=${samplesPerPixel}`);
  if (bitsPerSample !== 16) throw new Error(`unsupported bitsPerSample=${bitsPerSample}`);
  if (sampleFormat !== 1 && sampleFormat !== 2) throw new Error(`unsupported sampleFormat=${sampleFormat}`);

  let nodata = Number.NaN;
  if (nodataTag && nodataTag.length > 0) {
    let str = '';
    for (let i = 0; i < nodataTag.length; i++) {
      const c = nodataTag[i];
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    const parsed = parseFloat(str);
    if (Number.isFinite(parsed)) nodata = parsed;
  }

  const elevations = new Float32Array(width * height);
  const coverage = new Uint8Array(width * height);
  let coveredCount = 0;

  for (let stripIndex = 0; stripIndex < stripOffsets.length; stripIndex++) {
    const offset = stripOffsets[stripIndex];
    const byteCount = stripByteCounts[stripIndex];
    if (!Number.isFinite(offset) || !Number.isFinite(byteCount) || byteCount <= 0) continue;
    const encoded = bytes.subarray(offset, offset + byteCount);
    let decoded = encoded;
    if (compression === 5) decoded = decodeTIFFLZW(encoded);
    else if (compression === 8 || compression === 32946) decoded = await inflateDeflate(encoded);
    else if (compression !== 1) throw new Error(`unsupported TIFF compression=${compression}`);

    const stripRows = Math.min(rowsPerStrip, height - stripIndex * rowsPerStrip);
    const expectedBytes = width * stripRows * 2;
    if (decoded.byteLength < expectedBytes) continue;
    const stripView = new DataView(decoded.buffer, decoded.byteOffset, expectedBytes);
    for (let row = 0; row < stripRows; row++) {
      const dstY = stripIndex * rowsPerStrip + row;
      if (dstY >= height) break;
      for (let col = 0; col < width; col++) {
        const srcOff = (row * width + col) * 2;
        const value = sampleFormat === 2
          ? stripView.getInt16(srcOff, littleEndian)
          : stripView.getUint16(srcOff, littleEndian);
        const dstIdx = dstY * width + col;
        if (!Number.isFinite(value)) continue;
        if (Number.isFinite(nodata) && value === nodata) continue;
        if (value < MIN_VALID_ELEVATION_M || value > MAX_VALID_ELEVATION_M) continue;
        elevations[dstIdx] = value;
        coverage[dstIdx] = 1;
        coveredCount++;
      }
    }
  }

  const resampledSrc = { elevations, coverage, width, height };
  return {
    elevations: resampledSrc.elevations,
    coverage: resampledSrc.coverage,
    width: resampledSrc.width,
    height: resampledSrc.height,
    coveredCount,
  };
}

async function fetchSpainCoverage(coverage, mercZ, mercX, mercY) {
  const bounds = projectMercatorTileToSpainCoverageBounds(mercZ, mercX, mercY, coverage);
  const nativeWidth = Math.max(1, Math.round((bounds.maxE - bounds.minE) / SPAIN_DEM_RESOLUTION_M));
  const nativeHeight = Math.max(1, Math.round((bounds.maxN - bounds.minN) / SPAIN_DEM_RESOLUTION_M));
  // Plafonne le raster demandé à la grille native du MDT5 : plus fin serait un
  // SURÉCHANTILLONNAGE bilinéaire côté serveur d'altitudes Int16 au mètre, la
  // source des bandes horizontales des overlays pente / altitude à z14+. Voir le
  // commentaire de buildSpainWCSUrl pour l'explication complète.
  const outW = Math.max(1, Math.min(SPAIN_WCS_OUTPUT_PX, nativeWidth));
  const outH = Math.max(1, Math.min(SPAIN_WCS_OUTPUT_PX, nativeHeight));
  const url = buildSpainWCSUrl(coverage, bounds, outW, outH);

  const response = await spainScheduleFetch(async () => {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(SPAIN_FETCH_TIMEOUT_MS), priority: 'high' });
    } catch (error) {
      return { _error: error };
    }
  });

  if (response === SPAIN_PRUNED_SENTINEL) return { status: 'transient' };
  if (response?._error) return { status: 'transient', error: response._error };
  if (!response?.ok) {
    return {
      status: response && response.status >= 400 && response.status < 500 ? 'permanent' : 'transient',
      httpStatus: response?.status || 0,
    };
  }

  // Le serveur renvoie parfois un minuscule TIFF de remplacement (~500 o) pour
  // les tuiles entièrement en mer / hors couverture. parseSpainGeoTIFF lève alors
  // 'TIFF buffer too short' ; on l'intercepte et on le remonte comme 'empty', pour
  // que le dispatcher enregistre un cache négatif propre et passe au chemin
  // mondial au lieu de laisser remonter un rejet non géré.
  let parsed;
  try {
    parsed = await parseSpainGeoTIFF(await response.arrayBuffer());
  } catch (error) {
    if (DEBUG) console.warn('[spain] TIFF parse failed', error?.message || error);
    return { status: 'empty' };
  }
  if (!parsed.coveredCount) return { status: 'empty' };

  // Comblement des trous sur le raster UTM SOURCE (désormais
  // SPAIN_WCS_OUTPUT_PX²) avant la reprojection, pour que l'échantillonneur par
  // moyenne de blocs ne puise pas dans des trous près du bord de couverture.
  fillSpainCoverage(parsed.elevations, parsed.coverage, parsed.width);

  // Passe-bas préservant les arêtes sur le raster SOURCE pour dissoudre la
  // quantification Int16 au mètre. Le MDT5 stocke des altitudes en mètres
  // entiers : une pente douce (p. ex. 4 % = 20 cm par pixel de 5 m) se matérialise
  // en lignes alternées « 0 m / +1 m ». Horn 3×3 dans slope.js en fait ensuite les
  // bandes régulières visibles sur les overlays d'Andalousie / des Pyrénées. Le
  // lissage doit s'exécuter sur le raster UTM (où vit physiquement la
  // quantification) AVANT la reprojection, sinon il contamine les pixels le long
  // de l'axe tourné de la grille de destination. Le seuil de 4 mètres laisse
  // intactes toutes les vraies falaises / crêtes.
  smoothSpainQuantization(parsed.elevations, parsed.coverage, parsed.width, parsed.height);

  // Reprojette le raster UTM source sur la grille de la tuile Mercator avec la
  // même convention par pixel (lng, lat) que l'échantillonneur IGN/build-tile.
  // Sans cela, le raster UTM brut aligné sur ses axes était traité comme s'il
  // était déjà aligné sur Mercator, d'où des décalages sous-pixel le long de
  // chaque bord de tuile — visibles en 3D comme un « mur » vertical de quelques
  // mètres entre tuiles espagnoles voisines en terrain raide (Pyrénées, Picos de
  // Europa, Sierra Nevada).
  const projected = _resampleSpainSourceToMercator(
    parsed.elevations,
    parsed.coverage,
    parsed.width,
    parsed.height,
    bounds,
    mercZ,
    mercX,
    mercY,
    coverage.utmZone,
  );

  despikeElevations(projected.elevations, projected.coverage, DEM_TILE_SIZE);
  return {
    status: 'ok',
    elevations: projected.elevations,
    coverage: projected.coverage,
    nativeWidth,
    nativeHeight,
  };
}

async function buildSpainTile(mercZ, mercX, mercY) {
  const t0 = performance.now();
  if (!tileOverlapsSpain(mercZ, mercX, mercY)) {
    return {
      blob: null,
      elevations: null,
      coverage: null,
      source: 'spain-outside',
      allPermanentMissing: true,
      pendingFetches: null,
    };
  }

  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const centerLng = (bounds.west + bounds.east) / 2;
  const centerLat = (bounds.north + bounds.south) / 2;
  const coverage = pickSpainCoverage(centerLng, centerLat);
  let sawTransientFailure = false;

  const result = await fetchSpainCoverage(coverage, mercZ, mercX, mercY);
  if (result.status === 'ok') {
    if (DEBUG) {
      const dt = (performance.now() - t0).toFixed(1);
      console.log(
        `[spain][build] %c ${mercZ}/${mercX}/${mercY} %c ${coverage.coverageId} ${dt}ms`,
        'background:#A63A00;color:#fff;padding:1px 4px;border-radius:2px',
        '',
      );
    }
    return {
      blob: null,
      elevations: result.elevations,
      coverage: result.coverage,
      source: `spain-mdt-${coverage.epsg}`,
      allPermanentMissing: false,
      pendingFetches: null,
    };
  }
  if (result.status === 'transient') sawTransientFailure = true;

  return {
    blob: null,
    elevations: null,
    coverage: null,
    source: sawTransientFailure ? 'spain-unavailable' : 'spain-empty',
    allPermanentMissing: !sawTransientFailure,
    pendingFetches: null,
  };
}