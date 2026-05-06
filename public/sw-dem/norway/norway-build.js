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

function _resampleNorwayCoverage(elevations, coverage, srcWidth, srcHeight) {
  if (srcWidth === DEM_TILE_SIZE && srcHeight === DEM_TILE_SIZE) {
    return { elevations, coverage };
  }

  const outElev = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  const outCov = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const sy = Math.min(srcHeight - 1, Math.floor(((py + 0.5) / DEM_TILE_SIZE) * srcHeight));
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const sx = Math.min(srcWidth - 1, Math.floor(((px + 0.5) / DEM_TILE_SIZE) * srcWidth));
      const srcIdx = sy * srcWidth + sx;
      const dstIdx = py * DEM_TILE_SIZE + px;
      if (coverage[srcIdx]) {
        outElev[dstIdx] = elevations[srcIdx];
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

  const resampled = _resampleNorwayCoverage(elevations, coverage, width, height);
  return {
    elevations: resampled.elevations,
    coverage: resampled.coverage,
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

  return `${cfg.base}`
    + `?service=WCS`
    + `&version=${NORWAY_WCS_VERSION}`
    + `&request=GetCoverage`
    + `&coverage=${encodeURIComponent(cfg.coverage)}`
    + `&crs=EPSG:${cfg.epsg}`
    + `&bbox=${bbox}`
    + `&width=${DEM_TILE_SIZE}`
    + `&height=${DEM_TILE_SIZE}`
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

  const parsed = await parseNorwayGeoTIFF(await response.arrayBuffer());
  if (!parsed.coveredCount) return { status: 'empty' };
  return {
    status: 'ok',
    elevations: parsed.elevations,
    coverage: parsed.coverage,
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