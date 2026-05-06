// ---------------------------------------------------------------------------
// Norway — build a Mercator DEM tile from Kartverket NHM DTM WCS
// ---------------------------------------------------------------------------

const NORWAY_PRUNED_SENTINEL = Object.freeze({ _norwayPruned: true });

let _norwayActive = 0;
const _norwayQueue = [];

function norwayScheduleFetch(fn) {
  return new Promise((resolve, reject) => {
    _norwayQueue.push({ fn, resolve, reject, ts: performance.now() });
    while (_norwayQueue.length > NORWAY_QUEUE_MAX) {
      let oldestIdx = 0;
      let oldestTs = _norwayQueue[0].ts;
      for (let i = 1; i < _norwayQueue.length; i++) {
        if (_norwayQueue[i].ts < oldestTs) {
          oldestTs = _norwayQueue[i].ts;
          oldestIdx = i;
        }
      }
      const stale = _norwayQueue.splice(oldestIdx, 1)[0];
      stale.resolve(NORWAY_PRUNED_SENTINEL);
    }
    drainNorwayQueue();
  });
}

function drainNorwayQueue() {
  while (_norwayActive < NORWAY_CONCURRENCY && _norwayQueue.length > 0) {
    const { fn, resolve, reject } = _norwayQueue.pop();
    _norwayActive++;
    fn().then(resolve).catch(reject).finally(() => {
      _norwayActive--;
      drainNorwayQueue();
    });
  }
}

function _norwayReadIFDTags(view, bytes, ifdOffset, littleEndian) {
  if (ifdOffset + 2 > bytes.byteLength) throw new Error('IFD outside TIFF buffer');
  const numEntries = view.getUint16(ifdOffset, littleEndian);
  const entriesStart = ifdOffset + 2;
  const tags = new Map();
  for (let i = 0; i < numEntries; i++) {
    const entryOff = entriesStart + i * 12;
    const tag = view.getUint16(entryOff, littleEndian);
    const type = view.getUint16(entryOff + 2, littleEndian);
    const count = view.getUint32(entryOff + 4, littleEndian);
    tags.set(tag, { type, count, entryOff });
  }
  return {
    get(tagId) {
      const tag = tags.get(tagId);
      if (!tag) return null;
      return readTagValue(view, tag.entryOff, tag.type, tag.count, littleEndian, bytes);
    },
  };
}

function _norwayDecodeTileBytes(compression, encoded) {
  if (compression === 1) return Promise.resolve(encoded);
  if (compression === 5) return Promise.resolve(decodeTIFFLZW(encoded));
  if (compression === 8 || compression === 32946) return inflateDeflate(encoded);
  throw new Error(`unsupported TIFF compression=${compression}`);
}

function _resampleNorwaySourceToMercator(
  srcElev, srcCov, srcW, srcH, bounds, mercZ, mercX, mercY, zone,
) {
  // Same area-weighted box-average reprojection used by the Spain pipeline
  // (see spain-build.js for the full rationale). Two regimes:
  //   (A) src pitch ≤ dst pitch → average all source pixels touching each
  //       destination pixel's UTM footprint (anti-aliasing).
  //   (B) src pitch > dst pitch → coverage-weighted bilinear at the centroid
  //       (proper interpolation when source is the limiting band).
  // Per-pixel reprojection also closes the inter-tile seam that the previous
  // identity passthrough produced (adjacent Mercator tiles fetch DIFFERENT
  // UTM bboxes — only sampling at common (lng, lat) keeps edges continuous).
  const outElev = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const outCov = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const n = 1 << mercZ;
  const dE = bounds.maxE - bounds.minE;
  const dN = bounds.maxN - bounds.minN;
  if (!(dE > 0) || !(dN > 0)) return { elevations: outElev, coverage: outCov };

  const invDE = 1 / dE;
  const invDN = 1 / dN;

  const C = DEM_TILE_SIZE + 1;
  const fX = new Float32Array(C * C);
  const fY = new Float32Array(C * C);
  for (let cy = 0; cy < C; cy++) {
    const yFrac = (mercY + cy / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);
    for (let cx = 0; cx < C; cx++) {
      const xFrac = (mercX + cx / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;
      const p = wgs84ToNorwayUTM(lng, lat, zone);
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

      let sxMin = x00; if (x10 < sxMin) sxMin = x10; if (x01 < sxMin) sxMin = x01; if (x11 < sxMin) sxMin = x11;
      let sxMax = x00; if (x10 > sxMax) sxMax = x10; if (x01 > sxMax) sxMax = x01; if (x11 > sxMax) sxMax = x11;
      let syMin = y00; if (y10 < syMin) syMin = y10; if (y01 < syMin) syMin = y01; if (y11 < syMin) syMin = y11;
      let syMax = y00; if (y10 > syMax) syMax = y10; if (y01 > syMax) syMax = y01; if (y11 > syMax) syMax = y11;

      const dstIdx = py * DEM_TILE_SIZE + px;

      if (sxMax <= 0 || syMax <= 0 || sxMin >= srcW || syMin >= srcH) continue;
      if (sxMin < 0) sxMin = 0;
      if (syMin < 0) syMin = 0;
      if (sxMax > srcW) sxMax = srcW;
      if (syMax > srcH) syMax = srcH;

      const fwX = sxMax - sxMin;
      const fwY = syMax - syMin;

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

      const ix0 = Math.floor(sxMin);
      const iy0 = Math.floor(syMin);
      const ix1 = Math.min(srcW - 1, Math.ceil(sxMax) - 1);
      const iy1 = Math.min(srcH - 1, Math.ceil(syMax) - 1);
      let sum = 0;
      let wSum = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const dy = Math.min(syMax, iy + 1) - Math.max(syMin, iy);
        if (dy <= 0) continue;
        const rowBase = iy * srcW;
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = Math.min(sxMax, ix + 1) - Math.max(sxMin, ix);
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

async function parseNorwayGeoTIFF(buffer) {
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
  const tags = _norwayReadIFDTags(view, bytes, ifdOffset, littleEndian);
  const width = tags.get(T_ImageWidth)?.[0] ?? 0;
  const height = tags.get(T_ImageLength)?.[0] ?? 0;
  const tileW = tags.get(T_TileWidth)?.[0] ?? 0;
  const tileH = tags.get(T_TileLength)?.[0] ?? 0;
  const compression = tags.get(T_Compression)?.[0] ?? 1;
  const bitsPerSample = tags.get(T_BitsPerSample)?.[0] ?? 8;
  const sampleFormat = tags.get(T_SampleFormat)?.[0] ?? 1;
  const samplesPerPixel = tags.get(T_SamplesPerPixel)?.[0] ?? 1;
  const tileOffsets = tags.get(T_TileOffsets);
  const tileByteCounts = tags.get(T_TileByteCounts);
  const nodataTag = tags.get(T_GDAL_NODATA);

  if (!width || !height) throw new Error('missing TIFF width/height');
  if (!tileW || !tileH) throw new Error('Norway WCS TIFF is not tiled');
  if (!tileOffsets || !tileByteCounts) throw new Error('missing TIFF tile offsets');
  if (samplesPerPixel !== 1) throw new Error(`unsupported samplesPerPixel=${samplesPerPixel}`);
  if (sampleFormat !== 3 || bitsPerSample !== 32) {
    throw new Error(`unsupported sample format=${sampleFormat} bits=${bitsPerSample}`);
  }

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

  const tilesAcross = Math.ceil(width / tileW);
  const elevations = new Float32Array(width * height);
  const coverage = new Uint8Array(width * height);
  let coveredCount = 0;

  for (let tileIndex = 0; tileIndex < tileOffsets.length; tileIndex++) {
    const offset = tileOffsets[tileIndex];
    const byteCount = tileByteCounts[tileIndex];
    if (!Number.isFinite(offset) || !Number.isFinite(byteCount) || byteCount <= 0) continue;
    const encoded = bytes.subarray(offset, offset + byteCount);
    const decoded = await _norwayDecodeTileBytes(compression, encoded);
    const expectedTileBytes = tileW * tileH * 4;
    if (decoded.byteLength < expectedTileBytes) continue;
    const tileView = new DataView(decoded.buffer, decoded.byteOffset, expectedTileBytes);
    const tx = tileIndex % tilesAcross;
    const ty = Math.floor(tileIndex / tilesAcross);
    const dstX0 = tx * tileW;
    const dstY0 = ty * tileH;
    const copyW = Math.min(tileW, width - dstX0);
    const copyH = Math.min(tileH, height - dstY0);

    for (let row = 0; row < copyH; row++) {
      for (let col = 0; col < copyW; col++) {
        const srcIdx = row * tileW + col;
        const dstIdx = (dstY0 + row) * width + (dstX0 + col);
        const value = tileView.getFloat32(srcIdx * 4, littleEndian);
        if (!Number.isFinite(value)) continue;
        if (Number.isFinite(nodata) && value === nodata) continue;
        if (value < MIN_VALID_ELEVATION_M || value > MAX_VALID_ELEVATION_M) continue;
        elevations[dstIdx] = value;
        coverage[dstIdx] = 1;
        coveredCount++;
      }
    }
  }

  const resampled = { elevations, coverage, width, height };
  return {
    elevations: resampled.elevations,
    coverage: resampled.coverage,
    width: resampled.width,
    height: resampled.height,
    coveredCount,
  };
}

function buildNorwayWCSUrl(zone, mercZ, mercX, mercY) {
  const cfg = NORWAY_WCS_ZONES[zone];
  if (!cfg) throw new Error(`unsupported Norway zone ${zone}`);
  const extent = projectMercatorTileToNorwayUTMExtent(mercZ, mercX, mercY, zone);
  const bbox = [
    extent.minE.toFixed(3),
    extent.minN.toFixed(3),
    extent.maxE.toFixed(3),
    extent.maxN.toFixed(3),
  ].join(',');

  // Request NORWAY_WCS_OUTPUT_PX² (512²) — 4× the destination pitch — so the
  // local UTM→Mercator reprojection has enough source samples per output
  // pixel to do area-weighted box averaging instead of point-bilinear. This
  // is what eliminates the slope/altitude grid moiré on Norwegian terrain.
  return `${cfg.base}`
    + `?service=WCS`
    + `&version=${NORWAY_WCS_VERSION}`
    + `&request=GetCoverage`
    + `&coverage=${encodeURIComponent(cfg.coverage)}`
    + `&crs=EPSG:${cfg.epsg}`
    + `&bbox=${bbox}`
    + `&width=${NORWAY_WCS_OUTPUT_PX}`
    + `&height=${NORWAY_WCS_OUTPUT_PX}`
    + `&format=${encodeURIComponent(NORWAY_WCS_FORMAT)}`
    + `&interpolation=linear`;
}

async function fetchNorwayCoverage(zone, mercZ, mercX, mercY) {
  const url = buildNorwayWCSUrl(zone, mercZ, mercX, mercY);
  const response = await norwayScheduleFetch(async () => {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(NORWAY_FETCH_TIMEOUT_MS) });
    } catch (error) {
      return { _error: error };
    }
  });
  if (response === NORWAY_PRUNED_SENTINEL) return { status: 'transient' };
  if (response?._error) return { status: 'transient', error: response._error };
  if (!response?.ok) {
    return {
      status: response && response.status >= 400 && response.status < 500 ? 'permanent' : 'transient',
      httpStatus: response?.status || 0,
    };
  }

  let parsed;
  try {
    parsed = await parseNorwayGeoTIFF(await response.arrayBuffer());
  } catch (error) {
    if (DEBUG) console.warn('[norway] TIFF parse failed', error?.message || error);
    return { status: 'empty' };
  }
  if (!parsed.coveredCount) return { status: 'empty' };

  // Reproject UTM source raster onto Mercator with area-weighted box
  // averaging — closes inter-tile seams AND removes the slope/altitude
  // grid moiré that point-bilinear produces when src pitch ≈ dst pitch.
  const extent = projectMercatorTileToNorwayUTMExtent(mercZ, mercX, mercY, zone);
  const projected = _resampleNorwaySourceToMercator(
    parsed.elevations,
    parsed.coverage,
    parsed.width,
    parsed.height,
    extent,
    mercZ,
    mercX,
    mercY,
    zone,
  );
  return {
    status: 'ok',
    elevations: projected.elevations,
    coverage: projected.coverage,
  };
}

async function buildNorwayTile(mercZ, mercX, mercY) {
  const t0 = performance.now();

  if (!tileOverlapsNorway(mercZ, mercX, mercY)) {
    return {
      blob: null,
      elevations: null,
      coverage: null,
      source: 'norway-outside',
      allPermanentMissing: true,
      pendingFetches: null,
    };
  }

  const bounds = mercatorTileBounds(mercZ, mercX, mercY);
  const centerLng = (bounds.west + bounds.east) / 2;
  const zoneOrder = getNorwayZoneOrder(centerLng);
  let sawTransientFailure = false;

  for (const zone of zoneOrder) {
    const result = await fetchNorwayCoverage(zone, mercZ, mercX, mercY);
    if (result.status === 'ok') {
      despikeElevations(result.elevations, result.coverage, DEM_TILE_SIZE);
      if (DEBUG) {
        const dt = (performance.now() - t0).toFixed(1);
        console.log(
          `[norway][build] %c ${mercZ}/${mercX}/${mercY} %c zone=${zone} dtm=1m ${dt}ms`,
          'background:#0B6E4F;color:#fff;padding:1px 4px;border-radius:2px',
          '',
        );
      }
      return {
        blob: null,
        elevations: result.elevations,
        coverage: result.coverage,
        source: `norway-dtm-z${zone}`,
        allPermanentMissing: false,
        pendingFetches: null,
      };
    }
    if (result.status === 'transient') sawTransientFailure = true;
  }

  return {
    blob: null,
    elevations: null,
    coverage: null,
    source: sawTransientFailure ? 'norway-unavailable' : 'norway-empty',
    allPermanentMissing: !sawTransientFailure,
    pendingFetches: null,
  };
}