/**
 * RedView Test-Bench : DEM Service Worker (0.40 m surface pipeline)
 *
 * Charge les vrais modules classiques de public/sw-dem/ dans un contexte `vm`
 * (même code que le Service Worker) et mesure / vérifie :
 * 1. Encodage Terrain-RGB PNG — nouvelle version (RVB, filtre Up, scanlines
 *    directes) vs ancienne (RGBA non filtré, intermédiaire + copie). Les PNG
 *    doivent se décoder en pixels IDENTIQUES ; le nouveau est plus petit.
 * 2. Décodage « seedé » par l'encodeur — la grille Float32 mise en cache doit
 *    être bit-identique à celle décodée depuis le PNG (inflate zlib).
 * 3. Rééchantillonnage WMS 362×256 → 256² — nouvelle vs ancienne version,
 *    sortie bit-identique.
 * 4. Health guard — stats du parent : ancien chemin (overzoom Catmull-Rom +
 *    encodage PNG) vs sous-rectangle du parent en cache (findCachedParentStats).
 */
import zlib from 'node:zlib';
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { loadSwModules, readSwConstant, type SwContext } from './core/sw-context.ts';

const SIZE = 256;

const SW_MODULES = [
  'core/config.js',
  'core/geo.js',
  'core/interpolation.js',
  'core/terrain-rgb.js',
  'sources/mapbox.js',
  'sources/ign-scheduler.js',
  'sources/ign-network.js',
  'sources/ign-cancel.js',
  'sources/ign-fetcher.js',
  'sources/ign-highres.js',
  'sources/ign-wms-raster.js',
  'sources/ign-wms-tiles.js',
  'runtime/dem-helpers.js',
  'runtime/dem-health.js',
];

// The SW modules are classic scripts evaluated in THIS realm, once per
// process (core/sw-context.ts): a contextified vm global made sandboxed code
// look 10-30x slower than the in-realm legacy copies.
function loadSwContext(): SwContext {
  const g = globalThis as unknown as SwContext;
  // Other national pipelines are out of scope for this bench.
  g.tileOverlapsSwitzerland = () => false;
  g.tileOverlapsNorway = () => false;
  g.tileOverlapsSpain = () => false;
  return loadSwModules(SW_MODULES);
}

// ── Synthetic data ────────────────────────────────────────────────────
function makeRng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** MNS-like surface: relief + canopy/building noise, 0.1 m quantisation-hostile. */
function syntheticSurface(size: number, seed = 42): Float32Array {
  const rnd = makeRng(seed);
  const e = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 800 + 120 * Math.sin(x / 40) + 90 * Math.cos(y / 33) + 30 * Math.sin((x + y) / 11);
      h += 6 * (rnd() - 0.5);
      if (rnd() < 0.02) h += 20 * rnd();
      e[y * size + x] = h;
    }
  }
  return e;
}

/** Metre-square WMS raster (width = 256/cos(45°)) with duplicated rows + NODATA holes. */
function syntheticWmsRaster(): { raw: Float32Array; w: number; h: number } {
  const h = SIZE;
  const w = Math.round(SIZE / Math.cos((45 * Math.PI) / 180));
  const rnd = makeRng(7);
  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcY = y % 3 === 2 ? y - 1 : y; // nearest-neighbour row duplication
    for (let x = 0; x < w; x++) {
      raw[y * w + x] = 500 + 50 * Math.sin(x / 25) + 40 * Math.cos(srcY / 19) + 3 * rnd();
    }
  }
  for (let i = 0; i < 400; i++) raw[Math.floor(rnd() * raw.length)] = NaN;
  for (let i = 0; i < 50; i++) raw[Math.floor(rnd() * raw.length)] = -99999;
  return { raw, w, h };
}

// ── Reference (pre-change) implementations ────────────────────────────
async function legacyBuildRawPng(width: number, height: number, rgba: Uint8Array, ctx: SwContext): Promise<Blob> {
  const rowLen = width * 4;
  const rowBytes = 1 + rowLen;
  const raw = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    const srcOff = y * rowLen;
    raw[off] = 0;
    for (let i = 0; i < rowLen; i++) raw[off + 1 + i] = rgba[srcOff + i];
  }
  const build = ctx.buildPngFromScanlines as (w: number, h: number, r: Uint8Array) => Promise<Blob>;
  return build(width, height, raw);
}

async function legacyEncodeTerrainRGBPng(elevations: Float32Array, ctx: SwContext): Promise<Blob> {
  const sanitize = ctx.sanitizeElevation as (v: number) => number;
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < elevations.length; i++) {
    const height = sanitize(elevations[i]);
    const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
    const idx = i * 4;
    rgba[idx] = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >> 8) & 0xff;
    rgba[idx + 2] = val & 0xff;
    rgba[idx + 3] = 255;
  }
  return legacyBuildRawPng(SIZE, SIZE, rgba, ctx);
}

function legacyMnsWmsResample(raw: Float32Array, srcWidth: number, srcHeight: number, ctx: SwContext): Float32Array {
  // Top-level `const`s of classic scripts live in the context's lexical scope,
  // not on the global object — read them through the context.
  const MIN = readSwConstant<number>('MIN_VALID_ELEVATION_M');
  const MAX = readSwConstant<number>('MAX_VALID_ELEVATION_M');
  const out = new Float32Array(SIZE * SIZE);
  const sx = srcWidth / SIZE;
  const sy = srcHeight / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(srcHeight, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < SIZE; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(srcWidth, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const v = raw[yy * srcWidth + xx];
          if (!Number.isNaN(v) && v >= MIN && v <= MAX) { sum += v; n++; }
        }
      }
      out[y * SIZE + x] = n > 0 ? sum / n : NaN;
    }
  }
  (ctx.decombDuplicateRows as (f: Float32Array, w: number, h: number) => number)(out, SIZE, SIZE);
  return out;
}

// ── PNG decode (Node) for bit-exact verification ──────────────────────
/** Elevations of a Terrain-RGB PNG (8-bit RGB or RGBA, any PNG filter), as a decoder reads them. */
function decodePngTerrainRgb(bytes: Uint8Array): Float32Array {
  let pos = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let channels = 4;
  while (pos < bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + pos).getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * stride);
  for (let y = 0; y < width; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predictor) & 0xff;
    }
  }
  const out = new Float32Array(width * width);
  for (let i = 0; i < width * width; i++) {
    const rgb = (pixels[i * channels] << 16) | (pixels[i * channels + 1] << 8) | pixels[i * channels + 2];
    out[i] = -10000 + rgb * 0.1;
  }
  return out;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < ua.length; i++) {
    // NaN payloads may differ; treat any NaN == NaN.
    if (ua[i] !== ub[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  }
  return true;
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`[bench-dem-sw] ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

export async function runDemSwBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('DEM Service Worker (0.40 m surface)');
  const iterations = options.quick ? 10 : 40;
  const ctx = loadSwContext();

  const encode = ctx.encodeTerrainRGBPng as (e: Float32Array) => Promise<Blob>;
  const decodedGet = ctx.decodedTerrainRgbGet as (b: Blob) => Float32Array | null;
  const resample = ctx.mnsWmsResampleToTile as (r: Float32Array, w: number, h: number) => Float32Array;
  const overzoom = ctx.overzoomDemElevations as (
    parent: Float32Array, parentZ: number, parentX: number, parentY: number, z: number, x: number, y: number,
  ) => Float32Array | null;
  const summarize = ctx.summarizeDemElevations as (e: Float32Array) => { min: number; max: number; mean: number };
  const findCachedParentStats = ctx.findCachedParentStats as (
    cache: unknown, z: number, x: number, y: number, profile?: string,
  ) => Promise<{ stats: { min: number; max: number; mean: number } } | null>;

  // ── Correctness ─────────────────────────────────────────────────────
  console.log('\n[bench-dem-sw] correctness checks');
  const surface = syntheticSurface(SIZE);
  const newPng = new Uint8Array(await (await encode(surface)).arrayBuffer());
  const oldPng = new Uint8Array(await (await legacyEncodeTerrainRGBPng(surface, ctx)).arrayBuffer());
  assert(sameBits(decodePngTerrainRgb(newPng), decodePngTerrainRgb(oldPng)),
    `encoder output decodes to the same pixels as legacy (${newPng.length} B vs ${oldPng.length} B, ${Math.round(100 * (1 - newPng.length / oldPng.length))} % smaller)`);
  assert(newPng.length < oldPng.length, 'RGB + Up filter tile smaller than the legacy RGBA tile');

  const blob = await encode(surface);
  const seeded = decodedGet(blob);
  assert(!!seeded && sameBits(seeded, decodePngTerrainRgb(new Uint8Array(await blob.arrayBuffer()))),
    'seeded decode grid bit-identical to PNG decode');

  const { raw, w, h } = syntheticWmsRaster();
  assert(sameBits(resample(raw.slice(), w, h), legacyMnsWmsResample(raw.slice(), w, h, ctx)),
    `WMS resample ${w}x${h} -> 256² bit-identical to legacy`);

  // Guard stats: France tile z16 with its z15 parent in the hot tier.
  const z = 16;
  const x = 33 * 1024 + 300; // ~Alps/Lyon range, inside FRANCE_BOUNDS
  const y = 23 * 1024 + 400;
  const pZ = 15;
  const pX = x >> 1;
  const pY = y >> 1;
  const parentElev = syntheticSurface(SIZE, 99);
  const parentBlob = await encode(parentElev);
  const parentHeaders: [string, string][] = [['X-DEM-Source', 'ign-lidar-hd-wms'], ['X-DEM-Health', 'ok']];
  const parentKey = `/dem-tiles/${pZ}/${pX}/${pY}`;
  ctx.demHotGet = (key: string) => (
    new URL(key).pathname === parentKey ? { blob: parentBlob, headers: parentHeaders } : null
  );
  const emptyCache = { match: async () => null };

  const legacyGuardStats = async () => {
    const pe = decodedGet(parentBlob) ?? parentElev;
    const out = overzoom(pe, pZ, pX, pY, z, x, y) as Float32Array;
    const png = await encode(out); // legacy path encoded, then decoded (decode now seeded)
    return summarize(decodedGet(png) ?? out);
  };
  const newInfo = await findCachedParentStats(emptyCache, z, x, y, 'default');
  const legacy = await legacyGuardStats();
  assert(!!newInfo, 'findCachedParentStats finds the hot-tier parent (no build)');
  const s = newInfo!.stats;
  assert(Math.abs(s.mean - legacy.mean) < 1 && Math.abs(s.min - legacy.min) < 5 && Math.abs(s.max - legacy.max) < 5,
    `guard stats match legacy overzoom (Δmean=${Math.abs(s.mean - legacy.mean).toFixed(3)} m, `
    + `Δmin=${Math.abs(s.min - legacy.min).toFixed(2)} m, Δmax=${Math.abs(s.max - legacy.max).toFixed(2)} m)`);

  // ── Timings ─────────────────────────────────────────────────────────
  await suite.measureAsync(
    { name: 'Encode Terrain-RGB PNG — legacy (RGBA + copie)', category: 'dem-encode-legacy', iterations },
    () => legacyEncodeTerrainRGBPng(surface, ctx),
  );
  await suite.measureAsync(
    { name: 'Encode Terrain-RGB PNG — RVB filtre Up + seed', category: 'dem-encode', iterations },
    () => encode(surface),
  );
  suite.measureSync(
    { name: 'Resample WMS 362x256 — legacy', category: 'wms-resample-legacy', iterations },
    () => legacyMnsWmsResample(raw, w, h, ctx),
  );
  suite.measureSync(
    { name: 'Resample WMS 362x256 — spans précalculés', category: 'wms-resample', iterations },
    () => resample(raw.slice(), w, h),
  );
  await suite.measureAsync(
    { name: 'Health guard parent — legacy (overzoom + PNG)', category: 'guard-legacy', iterations },
    () => legacyGuardStats(),
  );
  await suite.measureAsync(
    { name: 'Health guard parent — sous-rectangle en cache', category: 'guard', iterations },
    () => findCachedParentStats(emptyCache, z, x, y, 'default'),
  );

  return suite;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-dem-sw.ts')) {
  const quick = process.argv.includes('--quick');
  runDemSwBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
