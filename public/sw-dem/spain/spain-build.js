// ---------------------------------------------------------------------------
// Spain — build a Mercator DEM tile from the IGN / IDEE INSPIRE MDT WCS
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
    // FIFO: take the OLDEST queued task. The previous LIFO `pop()` made the
    // newest tile request always preempt older ones, so panning across the
    // Pyrenees produced a head-of-line block where the first viewport tiles
    // were perpetually pushed back and eventually pruned out as PRUNED_SENTINEL
    // — surfacing as "loading bloque a 1%" on the slope/altitude pill.
    const { fn, resolve, reject } = _spainQueue.shift();
    _spainActive++;
    fn().then(resolve).catch(reject).finally(() => {
      _spainActive--;
      drainSpainQueue();
    });
  }
}

function _resampleSpainCoverage(elevations, coverage, srcWidth, srcHeight) {
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

function fillSpainCoverage(elevations, coverage) {
  let coveredCount = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i]) coveredCount++;
  if (coveredCount === 0 || coveredCount === coverage.length) return coveredCount;

  for (let pass = 0; pass < 3; pass++) {
    const nextElevations = new Float32Array(elevations);
    const nextCoverage = new Uint8Array(coverage);
    let passChanged = false;
    for (let py = 0; py < DEM_TILE_SIZE; py++) {
      for (let px = 0; px < DEM_TILE_SIZE; px++) {
        const idx = py * DEM_TILE_SIZE + px;
        if (coverage[idx]) continue;
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = py + oy;
          if (ny < 0 || ny >= DEM_TILE_SIZE) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = px + ox;
            if ((ox === 0 && oy === 0) || nx < 0 || nx >= DEM_TILE_SIZE) continue;
            const nIdx = ny * DEM_TILE_SIZE + nx;
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

function buildSpainWCSUrl(coverage, bounds) {
  // scaleSize forces the server to return exactly SPAIN_WCS_OUTPUT_PX² pixels,
  // CloudFront-cacheable, regardless of the native footprint. Without it a
  // single z12 tile transfers ~8 MB of native 5 m raster which serialised the
  // SW fetch queue and tripped the 15 s timeout under realistic viewports.
  return 'https://servicios.idee.es/wcs-inspire/mdt'
    + `?service=WCS`
    + `&version=${SPAIN_WCS_VERSION}`
    + `&request=GetCoverage`
    + `&coverageId=${encodeURIComponent(coverage.coverageId)}`
    + `&format=${encodeURIComponent(SPAIN_WCS_FORMAT)}`
    + `&subset=x(${bounds.minE},${bounds.maxE})`
    + `&subset=y(${bounds.minN},${bounds.maxN})`
    + `&scaleSize=x(${SPAIN_WCS_OUTPUT_PX}),y(${SPAIN_WCS_OUTPUT_PX})`;
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

  const resampled = _resampleSpainCoverage(elevations, coverage, width, height);
  return {
    elevations: resampled.elevations,
    coverage: resampled.coverage,
    coveredCount,
  };
}

async function fetchSpainCoverage(coverage, mercZ, mercX, mercY) {
  const bounds = projectMercatorTileToSpainCoverageBounds(mercZ, mercX, mercY, coverage);
  const nativeWidth = Math.max(1, Math.round((bounds.maxE - bounds.minE) / SPAIN_DEM_RESOLUTION_M));
  const nativeHeight = Math.max(1, Math.round((bounds.maxN - bounds.minN) / SPAIN_DEM_RESOLUTION_M));
  const url = buildSpainWCSUrl(coverage, bounds);

  const response = await spainScheduleFetch(async () => {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(SPAIN_FETCH_TIMEOUT_MS) });
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

  // Server occasionally returns a tiny placeholder TIFF (~500 B) for tiles
  // that fall fully on ocean / outside coverage. parseSpainGeoTIFF throws
  // 'TIFF buffer too short' in that case; catch it and surface as 'empty'
  // so the dispatcher records a clean negative cache and falls through to
  // the global path instead of bubbling an unhandled rejection.
  let parsed;
  try {
    parsed = await parseSpainGeoTIFF(await response.arrayBuffer());
  } catch (error) {
    if (DEBUG) console.warn('[spain] TIFF parse failed', error?.message || error);
    return { status: 'empty' };
  }
  if (!parsed.coveredCount) return { status: 'empty' };

  fillSpainCoverage(parsed.elevations, parsed.coverage);
  despikeElevations(parsed.elevations, parsed.coverage, DEM_TILE_SIZE);
  return {
    status: 'ok',
    elevations: parsed.elevations,
    coverage: parsed.coverage,
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