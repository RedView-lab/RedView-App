// ============================================
// LiDAR HD — WebGL2 fallback viewer entry
// ============================================
// Invoked dynamically by ../viewer/main.ts when the WebGPU preflight fails.
// Same canvas, same overlay, same OPFS layout — but only the textured
// terrain mesh is rendered. No octree, no point billboards, no LiDAR
// rendering; the orthophoto is sampled at full resolution.

import { CameraController } from '../viewer/camera';
import { WebGLTerrainRenderer } from './renderer';
import type { TerrainGPUData } from './renderer';
import type { TerrainMeshWebGL, TerrainWorkerInput, TerrainWorkerOutput } from './terrainWorker';
import { stitchOrtho } from './orthoStitcher';
import { detectCrs } from '../coordConvert';
import type { PointCloudBounds, DetectedCrs } from '../types';

export interface WebGLViewerHandles {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  stats: HTMLElement;
}

export interface WebGLViewerOptions {
  buffer: ArrayBuffer;          // raw LAZ bytes
  altRefLabel: string;          // for the title / stats
  tileLabel: string;            // human label e.g. "1003,6547 LAMB93/IGN69"
}

interface ParsedHeader { bounds: PointCloudBounds; crs: DetectedCrs; }

// ---------------------------------------------------------------------------
// Device tier detection
// ---------------------------------------------------------------------------
// We support EVERY machine that can run WebGL2: from tiny Macs / Windows iGPU
// to high-end desktops. To do that we pick a quality tier per-device based on
// the cheapest signals available, then drive grid resolution, ortho texture
// cap and DPR from a single source of truth.
type DeviceTier = 'masterpiece' | 'high' | 'medium' | 'low' | 'minimal';

interface QualityProfile {
  tier: DeviceTier;
  maxGrid: number;       // worker grid cap
  minResM: number;       // worker cell-size floor
  textureCap: number;    // ortho texture max dimension
  dprCap: number;        // canvas DPR cap
  lowPower: boolean;     // GL context power preference
  reason: string;        // why we landed here (logged)
}

function detectDeviceTier(): QualityProfile {
  // Soft probe — none of these are mandatory; absent values fall back to
  // conservative defaults so we never crash a low-end machine.
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean; platform?: string };
  };
  const ua = (nav.userAgent || '').toLowerCase();
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = nav.hardwareConcurrency || 0;
  const isMobile = !!nav.userAgentData?.mobile
    || /android|iphone|ipad|ipod|mobile/.test(ua);
  const isMacIntel = /macintosh|mac os x/.test(ua) && /intel/.test(ua);

  // Probe a throwaway WebGL2 context just to read the renderer string.
  let rendererStr = '';
  let maxTexProbe = 0;
  try {
    const probe = document.createElement('canvas').getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null;
    if (probe) {
      maxTexProbe = (probe.getParameter(probe.MAX_TEXTURE_SIZE) as number) || 0;
      const dbg = probe.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        rendererStr = String(probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      }
      // Drop the context immediately
      const lose = probe.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch { /* noop */ }

  const isSoftware = /(swiftshader|llvmpipe|lavapipe|microsoft basic|warp|software)/.test(rendererStr);
  const isAppleSilicon = /apple m\d/.test(rendererStr) || (/apple gpu/.test(rendererStr) && !isMacIntel);
  const isMobileGPU = /(adreno|mali|powervr|videocore)/.test(rendererStr);
  const isOldIntel = /(hd graphics (3000|4000|4400|4600)|intel\(r\) hd)/.test(rendererStr);

  // -- Decision tree (most restrictive first) --
  if (isSoftware) return profile('minimal', 'software renderer', { lowPower: true });
  if (isMobile || isMobileGPU) return profile('low', 'mobile GPU', { lowPower: true });
  if (isOldIntel || (isMacIntel && (mem && mem < 4))) return profile('low', 'old Intel iGPU / small Mac', { lowPower: true });
  if (isMacIntel) return profile('medium', 'Intel Mac', { lowPower: false });
  if (mem && mem < 4) return profile('low', `low RAM (${mem} GB)`, { lowPower: true });
  if (mem && mem < 8) return profile('medium', `medium RAM (${mem} GB)`, { lowPower: false });
  if (cores && cores < 4) return profile('medium', `${cores} cores`, { lowPower: false });

  // High-end paths
  if (isAppleSilicon) return profile('masterpiece', 'Apple Silicon', { lowPower: false });
  if (mem >= 16 || (mem >= 8 && cores >= 8)) return profile('masterpiece', `${mem || '?'} GB RAM, ${cores} cores`, { lowPower: false });
  return profile('high', 'default high tier', { lowPower: false });

  function profile(tier: DeviceTier, reason: string, extra: { lowPower: boolean }): QualityProfile {
    // Tier matrix tuned so that even MASTERPIECE fits in <300 MB GPU memory:
    //   2048² verts × 32 B (VBO) + 2047²×6 idx × 4 B (IBO) ≈ 230 MB.
    const matrix: Record<DeviceTier, { maxGrid: number; minResM: number; textureCap: number; dprCap: number }> = {
      masterpiece: { maxGrid: 2048, minResM: 0.25, textureCap: 8192, dprCap: 2.0 },
      high:        { maxGrid: 1536, minResM: 0.30, textureCap: 8192, dprCap: 2.0 },
      medium:      { maxGrid: 1024, minResM: 0.50, textureCap: 4096, dprCap: 1.5 },
      low:         { maxGrid: 640,  minResM: 0.80, textureCap: 4096, dprCap: 1.25 },
      minimal:     { maxGrid: 384,  minResM: 1.20, textureCap: 2048, dprCap: 1.0 },
    };
    const m = matrix[tier];
    // Honour real GPU texture limit if the probe gave us one
    const textureCap = maxTexProbe ? Math.min(m.textureCap, maxTexProbe) : m.textureCap;
    return { tier, ...m, textureCap, lowPower: extra.lowPower, reason };
  }
}

/**
 * Reads just enough of the LAZ header (LAS 1.x is fixed-layout, the bbox
 * lives at byte 179..226) to know the CRS + corner UVs *before* spinning
 * up the parsing worker. Avoids a chicken-and-egg with the ortho stitcher.
 *
 * Falls back to running the worker with placeholder UVs if the header
 * can't be read; the mesh would render with garbage UV but we always
 * succeed in reading a valid LAS header in practice.
 */
function readBoundsFromLasHeader(buffer: ArrayBuffer): ParsedHeader | null {
  try {
    const view = new DataView(buffer);
    // LAS magic "LASF"
    if (view.getUint32(0, false) !== 0x4C415346) return null;
    // Scale + offset start at byte 131. 8-byte little-endian doubles.
    const sX = view.getFloat64(131, true);
    const sY = view.getFloat64(139, true);
    const sZ = view.getFloat64(147, true);
    const oX = view.getFloat64(155, true);
    const oY = view.getFloat64(163, true);
    const oZ = view.getFloat64(171, true);
    const maxX = view.getFloat64(179, true);
    const minX = view.getFloat64(187, true);
    const maxY = view.getFloat64(195, true);
    const minY = view.getFloat64(203, true);
    const maxZ = view.getFloat64(211, true);
    const minZ = view.getFloat64(219, true);
    void sX; void sY; void sZ; void oX; void oY; void oZ;
    if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) return null;
    if (maxX <= minX || maxY <= minY) return null;
    const bounds: PointCloudBounds = { minX, maxX, minY, maxY, minZ, maxZ };
    const crs = detectCrs(minY, maxY);
    return { bounds, crs };
  } catch {
    return null;
  }
}

export async function runWebGLFallback(
  ui: WebGLViewerHandles,
  opts: WebGLViewerOptions,
): Promise<void> {
  const { canvas, overlay, status, bar, stats } = ui;
  const setStatus = (msg: string, pct?: number) => {
    status.textContent = msg;
    if (pct != null) bar.style.width = `${Math.min(100, pct)}%`;
  };

  setStatus('Mode WebGL HD : initialisation…', 1);

  // 0. Pick a quality tier for THIS device. Drives every memory-heavy knob
  // below so that the fallback runs on EVERY machine, from tiny Mac /
  // iGPU laptop up to high-end desktop ("masterpiece" tier = 4× the
  // WebGPU pipeline density).
  const profile = detectDeviceTier();
  console.log(
    `[WebGL Viewer] Quality tier = ${profile.tier} (${profile.reason}) ` +
    `→ grid ≤ ${profile.maxGrid}, res ≥ ${profile.minResM}m, ` +
    `tex ≤ ${profile.textureCap}, dpr ≤ ${profile.dprCap}, lowPower=${profile.lowPower}`,
  );

  // 1. WebGL2 init (cheap — fails fast on truly headless setups). Pass the
  // tier-aware power preference: "low-power" on tiny Macs to keep the
  // discrete GPU asleep and avoid spurious context-creation failures.
  resizeCanvas(canvas, profile.dprCap);
  const renderer = new WebGLTerrainRenderer(canvas, { lowPower: profile.lowPower });
  console.log(`[WebGL Viewer] ${renderer.rendererInfo} · maxTex=${renderer.maxTextureSize}`);

  // 2. Read LAS header inline so we know bounds + CRS without spinning a
  // worker. LAS 1.x is fixed-layout — bbox is at byte 179..226.
  const header = readBoundsFromLasHeader(opts.buffer);
  if (!header) throw new Error("En-tête LAS illisible — fichier corrompu ?");

  // 3. Kick off ortho stitch + terrain build IN PARALLEL. Stitch needs only
  // the header; terrain worker needs a stitched UV anchor — but in stitched
  // texture space the four corner UVs are already known ahead of any HTTP
  // request because they depend on bounds + CRS only. So we compute UVs
  // synchronously and start everything together.
  setStatus('Téléchargement orthophotos HD…', 5);
  // Pick the lowest of: hardware texture limit, tier cap. The stitcher
  // does its own clamping anyway, but passing a tier-aware value avoids
  // ever asking for an 8K canvas on a 2K-texture-limited iGPU.
  const orthoCap = Math.min(renderer.maxTextureSize, profile.textureCap);
  const stitchPromise = stitchOrtho(
    header.bounds, header.crs, orthoCap,
    (pct, label) => setStatus(`Mode WebGL HD : ${label}`, 5 + pct * 30),
  );

  // Terrain worker takes ownership of the buffer (transferable). We've
  // already extracted everything we need (header) on the main thread, so we
  // can hand it off without copying — important on RAM-constrained iGPU PCs.
  // We need the cornerUV before the worker can run. Wait on stitch first.
  const ortho = await stitchPromise;

  setStatus('Mode WebGL HD : maillage HD…', 40);
  const mesh = await runTerrainWorker(
    opts.buffer,
    ortho.cornerUV,
    profile.maxGrid,
    profile.minResM,
    (phase, pct) => setStatus(`Mode WebGL HD : ${phase}`, 40 + pct * 0.45),
  );

  // 6. Upload to GPU
  setStatus('Mode WebGL HD : upload GPU…', 90);
  renderer.uploadMesh(meshToGPUData(mesh));
  renderer.uploadOrtho(ortho.bitmap);
  ortho.bitmap.close();

  // 7. Camera + render loop
  const camera = new CameraController(canvas);
  camera.lookAt(0, (mesh.bounds.maxZ - mesh.bounds.minZ) / 2, 0, mesh.extent / 2);

  setStatus('Prêt — mode WebGL HD', 100);
  setTimeout(() => overlay.classList.add('hidden'), 250);

  // ---------------- SNOW ❄ ----------------
  // Same UX as the WebGPU viewer: bottom-of-screen button cycles
  // off → cover → thickness. First non-off click triggers a one-shot
  // AROME fetch + redistribution worker. Result is uploaded as an R32F
  // texture sampled in the fragment shader.
  const snowBtn = document.getElementById('snow-btn') as HTMLButtonElement | null;
  type SnowMode = { key: 'off' | 'cover' | 'thickness'; gpu: 0 | 1 | 2; label: string };
  const snowModes: SnowMode[] = [
    { key: 'off',       gpu: 0, label: '❄ Neige : off' },
    { key: 'cover',     gpu: 1, label: '❄ Couverture' },
    { key: 'thickness', gpu: 2, label: '❄ Épaisseur (cm)' },
  ];
  let snowIdx = 0;
  let snowFieldLoaded = false;
  let snowLoading = false;

  const cx = (mesh.bounds.minX + mesh.bounds.maxX) / 2;
  const cy = (mesh.bounds.minY + mesh.bounds.maxY) / 2;

  async function cycleSnow() {
    if (!snowBtn || snowLoading) return;
    const next = (snowIdx + 1) % snowModes.length;
    const mode = snowModes[next];
    if (!snowFieldLoaded && mode.gpu !== 0) {
      snowLoading = true;
      snowBtn.classList.add('loading');
      snowBtn.textContent = '❄ Calcul…';
      try {
        const { runSnowPipeline } = await import('../../snow');
        const field = await runSnowPipeline(
          {
            data: mesh.heightGrid,
            width: mesh.gridWidth,
            height: mesh.gridHeight,
            bounds: mesh.bounds,
            crs: header!.crs,
          },
          {
            progress: (pct, label) => {
              snowBtn.textContent = `❄ ${label} ${pct.toFixed(0)}%`;
            },
          },
        );
        // Snow field is row-major SOUTH→NORTH; the renderer's V axis goes
        // NORTH→SOUTH (snow originZ anchors the top edge at -maxY). Flip rows.
        const flipped = new Float32Array(field.data.length);
        for (let y = 0; y < field.height; y++) {
          const srcRow = (field.height - 1 - y) * field.width;
          const dstRow = y * field.width;
          for (let x = 0; x < field.width; x++) {
            flipped[dstRow + x] = field.data[srcRow + x];
          }
        }
        renderer.setSnow({
          data: flipped,
          width: field.width,
          height: field.height,
          originX: mesh.bounds.minX - cx,
          originZ: -(mesh.bounds.maxY - cy),
          scaleX: mesh.bounds.maxX - mesh.bounds.minX,
          scaleZ: mesh.bounds.maxY - mesh.bounds.minY,
        });
        snowFieldLoaded = true;
        console.log(
          `[WebGL Viewer] Snow loaded: avg=${field.stats.meanCm.toFixed(0)}cm, ` +
          `max=${field.stats.maxCm.toFixed(0)}cm, cov=${field.stats.coveragePct.toFixed(1)}%, ` +
          `${field.stats.elapsedMs.toFixed(0)}ms (AROME ${field.arome.timestamp})`,
        );
      } catch (err) {
        console.error('[WebGL Viewer] Snow fetch failed:', err);
        snowBtn.textContent = '❄ Erreur';
        setTimeout(() => { if (snowBtn) snowBtn.textContent = snowModes[0].label; }, 2500);
        snowIdx = 0;
        renderer.setSnowMode(0);
        snowLoading = false;
        snowBtn.classList.remove('loading');
        return;
      } finally {
        snowLoading = false;
        snowBtn.classList.remove('loading');
      }
    }
    snowIdx = next;
    renderer.setSnowMode(mode.gpu);
    snowBtn.textContent = mode.label;
    snowBtn.classList.toggle('active', mode.gpu !== 0);
  }
  snowBtn?.addEventListener('click', () => void cycleSnow());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'n' || e.key === 'N') void cycleSnow();
  });

  let lastFpsT = performance.now();
  let frames = 0;
  let fps = 0;

  const renderFrame = () => {
    const view = camera.getViewMatrix();
    const proj = camera.getProjMatrix();
    const vp = WebGLTerrainRenderer.multiplyMat4(view, proj);
    renderer.render(vp);

    frames++;
    const now = performance.now();
    if (now - lastFpsT >= 500) {
      fps = Math.round((frames * 1000) / (now - lastFpsT));
      frames = 0;
      lastFpsT = now;
      stats.textContent =
        `${(mesh.indexCount / 3).toLocaleString()} tri · ${fps} fps · ` +
        `terrain HD ${mesh.gridWidth}×${mesh.gridHeight} · ` +
        `${canvas.width}×${canvas.height} · WebGL2 [${profile.tier}] · ${opts.tileLabel}`;
    }
    requestAnimationFrame(renderFrame);
  };
  requestAnimationFrame(renderFrame);

  window.addEventListener('resize', () => {
    resizeCanvas(canvas, profile.dprCap);
    renderer.resize(canvas.width, canvas.height);
  });
}

function runTerrainWorker(
  buffer: ArrayBuffer,
  cornerUV: import('./terrainWorker').CornerUV,
  maxGrid: number,
  minResM: number,
  onProgress: (phase: string, pct: number) => void,
): Promise<TerrainMeshWebGL> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    const TIMEOUT_MS = 90_000;
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`Terrain worker timeout (${TIMEOUT_MS / 1000}s)`));
    }, TIMEOUT_MS);

    w.onmessage = (e: MessageEvent<TerrainWorkerOutput>) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress(m.phase, m.percent / 100);
      } else if (m.type === 'done') {
        clearTimeout(timer);
        w.terminate();
        resolve(m.mesh);
      } else if (m.type === 'error') {
        clearTimeout(timer);
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (err) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error(err.message || 'terrain worker error'));
    };

    const msg: TerrainWorkerInput = { type: 'build', buffer, cornerUV, maxGrid, minResM };
    w.postMessage(msg, [buffer]);
  });
}

function meshToGPUData(mesh: TerrainMeshWebGL): TerrainGPUData {
  return {
    vertices: mesh.vertices,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
  };
}

function resizeCanvas(canvas: HTMLCanvasElement, dprCap = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const w = Math.max(1, Math.floor(window.innerWidth * dpr));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
