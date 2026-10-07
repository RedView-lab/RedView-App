/**
 * RedView Test-Bench : viewer LiDAR sur chaque moteur et chaque navigateur
 *
 * Ouvre le build (`dist/`) dans Chromium et Firefox (Playwright) avec une
 * tuile LAS synthétique (syntheticTile.mjs : aucune donnée ni réseau
 * extérieur, tout appel hors du serveur local est coupé), en moteur
 * automatique (WebGPU si le navigateur en a un, sinon WebGL 2) et en
 * WebGL 2 forcé, puis vérifie :
 *   - la scène s'affiche (couverture du ciel), le moteur annoncé ;
 *   - EDL, mode de couleur, masquage du terrain, pentes et ensoleillement
 *     changent l'image (passes d'ombrage, profondeur, overlays) ;
 *   - clic droit : menu des outils au relâchement, menu natif bloqué même
 *     quand `contextmenu` arrive à l'appui (ordre Linux) ; glisser droit =
 *     déplacement sans menu ; molette en lignes (Firefox) = zoom ;
 *   - aucune exception, aucune erreur WebGL (`getError`, console) ;
 *   - CSP de production (server/lib/csp.mjs) sur les pages et les scripts de
 *     workers : WebAssembly compilé et `eval` refusé dans la page comme dans
 *     un worker, et aucune violation rapportée (le `report-uri` pointe sur ce
 *     serveur local) pendant tout le parcours.
 * Sous Linux (CI), c'est le chemin réel des utilisateurs : Firefox n'a pas
 * WebGPU et Chrome ne l'active que sur certains GPU. Quand le moteur
 * automatique d'un navigateur est déjà WebGL 2, le cas « webgl » forcé
 * referait le même chemin : il est sauté (≈ 165 s de SwiftShader en CI).
 *
 * `--browsers webkit` (Safari's engine, `npx playwright install webkit`):
 * no WebGPU, so WebGL 2; on Windows its OPFS writes leave empty files, the
 * tile then goes to CacheStorage like the app's saveTile does.
 *
 * Usage (après `npm run build:vite`) :
 *   node script-test-bench/lidar-viewer-engines/run.mjs
 *     [--browsers chromium,firefox,webkit] [--engines auto,webgl] [--dist dist]
 *     [--channel msedge] [--webgpu] [--firefox-no-webgpu] [--headed]
 *     [--expect-auto webgl|webgpu]
 * Captures et résumé : script-test-bench/reports/lidar-viewer-engines/.
 * Code de sortie non nul au premier contrôle en échec.
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { buildCspHeader } from '../../server/lib/csp.mjs';
import { buildSyntheticLas } from './syntheticTile.mjs';
import { coverage, decodePng, meanDifference } from './png.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPORT_DIR = join(ROOT, 'script-test-bench', 'reports', 'lidar-viewer-engines');
const TILE = { xKm: 965, yKm: 6500 };
const TILE_NAME = `LHD_FXX_0${TILE.xKm}_${TILE.yKm}_PTS_LAMB93_IGN69.copc.laz`;
const VIEWPORT = { width: 1280, height: 800 };
/** Clear colour of the scene pass without sunlight (0.76, 0.87, 0.96). */
const SKY = [194, 222, 245];
const LOAD_TIMEOUT_MS = 180_000;
const IDLE_TIMEOUT_MS = 60_000;
const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
/** Console lines that reveal a rendering fault. */
const GL_FAULT_RE = /GL_INVALID|INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|WebGL: |WebGL warning|shader compile failed|program link failed|framebuffer incomplete|Uncaptured error|context lost/i;

function parseArgs(argv) {
  const args = {
    browsers: ['chromium', 'firefox'],
    engines: ['auto', 'webgl'],
    dist: join(ROOT, 'dist'),
    channel: undefined,
    webgpu: false,
    firefoxNoWebgpu: false,
    headed: false,
    expectAuto: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--browsers') args.browsers = argv[++i].split(',').filter(Boolean);
    else if (arg === '--engines') args.engines = argv[++i].split(',').filter(Boolean);
    else if (arg === '--dist') args.dist = resolve(argv[++i]);
    else if (arg === '--channel') args.channel = argv[++i];
    else if (arg === '--webgpu') args.webgpu = true;
    else if (arg === '--firefox-no-webgpu') args.firefoxNoWebgpu = true;
    else if (arg === '--headed') args.headed = true;
    else if (arg === '--expect-auto') args.expectAuto = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Smallest valid WebAssembly module (magic + version): compiles only where CSP allows it. */
const EMPTY_WASM = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/** Same probe in a page and in a worker: [WebAssembly compiles, eval refused]. */
const CSP_PROBE = `(async () => {
  let wasm = false;
  let evalBlocked = false;
  try { await WebAssembly.compile(new Uint8Array(${JSON.stringify(EMPTY_WASM)})); wasm = true; } catch {}
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  return { wasm, evalBlocked };
})()`;

function startServer(dist, tile) {
  const root = normalize(dist + sep);
  /** CSP violation reports POSTed by the browsers (pages and workers). */
  const cspReports = [];
  let csp = '';
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const dest = String(req.headers['sec-fetch-dest'] ?? '');
    const isWorker = dest === 'worker' || dest === 'sharedworker' || dest === 'serviceworker';
    if (path === '/__csp-report') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const report = JSON.parse(body)['csp-report'] ?? JSON.parse(body);
        cspReports.push(`${report['effective-directive'] ?? report['violated-directive']} ← ${report['blocked-uri'] ?? '?'} (${report['source-file'] ?? report['document-uri'] ?? '?'})`);
      } catch {
        cspReports.push(`rapport illisible : ${body.slice(0, 200)}`);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/__csp-worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-security-policy': csp });
      res.end(`${CSP_PROBE}.then((result) => postMessage(result));`);
      return;
    }
    if (path === '/__tile') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tile.length });
      res.end(tile);
      return;
    }
    if (path === '/__blank') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>blank</title>');
      return;
    }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
      // As server.mjs: the policy rides on HTML pages and worker scripts.
      if (extname(file) === '.html' || isWorker) headers['content-security-policy'] = csp;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    // Production policy, reported here instead of GlitchTip, without the https upgrade of a local http origin.
    csp = buildCspHeader({ reportUri: `http://127.0.0.1:${server.address().port}/__csp-report`, upgradeInsecureRequests: false });
    server.cspReports = cspReports;
    r(server);
  }));
}

class Checks {
  constructor(label) {
    this.label = label;
    this.results = [];
  }

  record(name, ok, detail = '') {
    this.results.push({ name, ok, detail });
    console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  get failed() {
    return this.results.filter((r) => !r.ok);
  }
}

async function launch(browserName, args, profileDir) {
  if (browserName === 'chromium') {
    return chromium.launchPersistentContext(profileDir, {
      headless: !args.headed,
      channel: args.channel,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      // Machines without GPU acceleration (VMs, CI) draw WebGL in software.
      args: ['--enable-unsafe-swiftshader', ...(args.webgpu ? ['--enable-unsafe-webgpu'] : [])],
    });
  }
  if (browserName === 'webkit') {
    return webkit.launchPersistentContext(profileDir, { headless: !args.headed, viewport: VIEWPORT, deviceScaleFactor: 1 });
  }
  return firefox.launchPersistentContext(profileDir, {
    headless: !args.headed,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    firefoxUserPrefs: {
      // Software GL (CI) is blocklisted for WebGL by default.
      'webgl.force-enabled': true,
      ...(args.firefoxNoWebgpu ? { 'dom.webgpu.enabled': false } : {}),
    },
  });
}

/** Returns the backend the viewer ran on ('webgl', 'webgpu'), or null when it never got ready. */
async function runCase(browserName, engine, args, origin, checks, cspReports) {
  const reportsBefore = cspReports.length;
  const profileDir = await mkdtemp(join(tmpdir(), `rv-viewer-${browserName}-`));
  const context = await launch(browserName, args, profileDir);
  const consoleFaults = [];
  const pageErrors = [];
  const outDir = join(REPORT_DIR, `${browserName}-${engine}`);
  await mkdir(outDir, { recursive: true });
  try {
    // Only the local server: fonts, imagery and APIs are cut, as offline.
    await context.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    const page = context.pages()[0] ?? await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (/\[LiDAR GPU\]|\[Viewer\]/.test(text)) console.log(`    [${msg.type()}] ${text.slice(0, 260)}`);
      if ((msg.type() === 'error' || msg.type() === 'warning') && GL_FAULT_RE.test(text)) consoleFaults.push(text.slice(0, 400));
    });
    page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error).slice(0, 600)));
    page.on('crash', () => pageErrors.push('onglet planté (crash du processus de contenu)'));
    const consoleTail = [];
    let fatal = null;
    page.on('console', (msg) => {
      consoleTail.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
      if (consoleTail.length > 40) consoleTail.shift();
      if (/\[Viewer\] Fatal/.test(msg.text())) fatal ??= msg.text().slice(0, 300);
    });

    // 1. Tile stored as the app's downloader stores it (lib/storage.ts saveTile):
    // OPFS, size read back, CacheStorage when OPFS kept less (WebKit on Windows
    // reports the write and leaves an empty file).
    await page.goto(`${origin}/__blank`);
    const stored = await page.evaluate(async (name) => {
      const buf = await (await fetch('/__tile')).arrayBuffer();
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('lidar-hd', { create: true });
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(buf);
        await writable.close();
        if ((await handle.getFile()).size === buf.byteLength) return { bytes: buf.byteLength, where: 'OPFS' };
        await dir.removeEntry(name);
      } catch {
        // No OPFS writer in this browser.
      }
      const cache = await caches.open('redview-lidar-hd-v1');
      await cache.put(`/lidar-hd/${name}`, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
      return { bytes: buf.byteLength, where: 'CacheStorage' };
    }, TILE_NAME);
    checks.record('tuile stockée', stored.bytes > 0, `${(stored.bytes / 1e6).toFixed(1)} Mo · ${stored.where}`);

    // 2. Viewer.
    const engineParam = engine === 'webgl' ? '&engine=webgl' : '';
    const startedAt = Date.now();
    await page.goto(`${origin}/viewer.html?x=${TILE.xKm}&y=${TILE.yKm}&crs=LAMB93&alt=IGN69&bench=shots${engineParam}`);
    // A fatal error ends the wait at once (it used to hold the case for the whole timeout).
    const loadDeadline = Date.now() + LOAD_TIMEOUT_MS;
    let ready = false;
    while (!ready && !fatal && Date.now() < loadDeadline) {
      ready = await page.evaluate(
        () => document.getElementById('overlay')?.classList.contains('hidden') === true && !!window.__rvLidarShots,
      ).catch(() => false);
      if (!ready) await sleep(500);
    }
    const statusText = await page.evaluate(() => document.getElementById('status-detail')?.textContent ?? '').catch(() => '');
    checks.record('viewer prêt', ready, ready ? `${((Date.now() - startedAt) / 1000).toFixed(1)} s` : fatal ?? `statut : ${statusText}`);
    if (!ready) {
      const state = await page.evaluate(() => ({
        href: location.href,
        readyState: document.readyState,
        loader: !!document.getElementById('status-detail'),
        scripts: [...document.querySelectorAll('script')].map((s) => s.src || 'inline').slice(0, 5),
      })).catch((error) => ({ error: String(error) }));
      console.log(`    état : ${JSON.stringify(state)}`);
      for (const error of pageErrors) console.log(`    exception : ${error}`);
      for (const line of consoleTail) console.log(`    ${line}`);
      await page.screenshot({ path: join(outDir, 'echec.png') }).catch(() => undefined);
      return null;
    }

    // The production CSP really applies, in the page and in a worker: WebAssembly yes, eval no.
    const pageProbe = await page.evaluate(CSP_PROBE);
    const workerProbe = await page.evaluate(() => new Promise((done) => {
      const worker = new Worker('/__csp-worker.js');
      worker.onmessage = (event) => { done(event.data); worker.terminate(); };
      worker.onerror = (event) => done({ error: String(event.message ?? 'worker error') });
      setTimeout(() => done({ error: 'pas de réponse en 10 s' }), 10_000);
    }));
    for (const [where, probe] of [['page', pageProbe], ['worker', workerProbe]]) {
      checks.record(`CSP (${where}) : WebAssembly compilé, eval refusé`, probe.wasm === true && probe.evalBlocked === true, JSON.stringify(probe));
    }

    const waitIdle = async () => {
      const deadline = Date.now() + IDLE_TIMEOUT_MS;
      let calm = 0;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => window.__rvLidarShots.state());
        calm = !state.rendering && state.idle ? calm + 1 : 0;
        if (calm >= 3) return true;
        await sleep(200);
      }
      return false;
    };
    const clip = {
      x: Math.round(VIEWPORT.width * 0.34),
      y: Math.round(VIEWPORT.height * 0.2),
      width: Math.round(VIEWPORT.width * 0.32),
      height: Math.round(VIEWPORT.height * 0.6),
    };
    const shot = async (name) => {
      await waitIdle();
      const png = await page.screenshot({ clip });
      await writeFile(join(outDir, `${name}.png`), png);
      return decodePng(png);
    };
    const overlayDiffs = [];
    const changed = (name, before, after, min = 0.4) => {
      const diff = meanDifference(before, after);
      checks.record(name, diff >= min, `écart moyen ${diff.toFixed(2)}`);
      return diff;
    };
    const glErrors = () => page.evaluate(() => {
      const canvas = document.getElementById('canvas');
      const gl = canvas instanceof HTMLCanvasElement ? canvas.getContext('webgl2') : null;
      if (!gl) return null;
      const errors = [];
      for (let e = gl.getError(); e !== gl.NO_ERROR && errors.length < 8; e = gl.getError()) errors.push(`0x${e.toString(16)}`);
      return errors;
    });

    const stats = await page.evaluate(() => document.getElementById('stats')?.textContent ?? '');
    const backend = /WebGL 2/.test(stats) ? 'webgl' : /WebGPU/.test(stats) ? 'webgpu' : 'inconnu';
    const expected = engine === 'webgl' ? 'webgl' : args.expectAuto;
    checks.record('moteur', backend !== 'inconnu' && (!expected || backend === expected), `${backend}${expected ? ` (attendu ${expected})` : ''} · ${stats.slice(-60)}`);

    const base = await shot('base');
    const covered = coverage(base, SKY);
    checks.record('scène affichée', covered > 0.3, `${(covered * 100).toFixed(0)} % de l'image hors ciel`);

    // 3. Rendering paths. The EDL switch's thumb covers its checkbox when on: click the input itself.
    const toggleEdl = () => page.locator('#panel-edl-toggle').evaluate((input) => input.click());
    await toggleEdl();
    changed('EDL (profondeur relue)', base, await shot('edl'));
    await toggleEdl();

    await page.click('#panel-color-mode-button');
    await page.click('[data-color-mode-option="classification"]');
    overlayDiffs.push(changed('couleurs par classe (ré-ombrage des nœuds)', base, await shot('classification')));
    await page.click('#panel-color-mode-button');
    await page.click('[data-color-mode-option="rgb"]');

    await page.keyboard.press('t');
    changed('terrain masqué', base, await shot('sans-terrain'), 0.05);
    await page.keyboard.press('t');

    const sectionSwitch = (title) => page.locator('.rvc-section', { has: page.locator('.rvc-section__title-btn', { hasText: title }) })
      .locator('[role="switch"]').first();
    await sectionSwitch(/Pentes|Slopes/).click();
    overlayDiffs.push(changed('overlay des pentes', base, await shot('pentes')));
    await sectionSwitch(/Pentes|Slopes/).click();

    await sectionSwitch(/Ensoleillement|Sunlight/).click();
    overlayDiffs.push(changed('ensoleillement (soleil, ombres portées)', base, await shot('ensoleillement')));
    await sectionSwitch(/Ensoleillement|Sunlight/).click();
    // The learnt still budget may differ from the first view (slow GPUs halve it), so the
    // density can change a little; an overlay left on would differ as much as when shown.
    const restoredDiff = meanDifference(base, await shot('restauree'));
    checks.record('overlays retirés', restoredDiff < 0.5 * Math.min(...overlayDiffs), `écart ${restoredDiff.toFixed(2)} (overlays ≥ ${Math.min(...overlayDiffs).toFixed(2)})`);

    // 4. Input (each gesture starts on an idle viewer: a software rasteriser takes seconds per still frame).
    const cx = VIEWPORT.width / 2;
    const cy = VIEWPORT.height / 2;
    const menu = page.locator('.rv-lidar-ctx');
    // Linux delivers `contextmenu` on the press (Windows on the release): it must be
    // cancelled (no native menu) and must not open the tools menu by itself.
    await waitIdle();
    await page.mouse.move(cx, cy);
    const nativeMenuBlocked = await page.evaluate(([x, y]) => !document.getElementById('canvas').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }),
    ), [cx, cy]);
    await sleep(500);
    checks.record('clic droit : menu natif bloqué (contextmenu à l\'appui)', nativeMenuBlocked && !(await menu.isVisible()));
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    const opened = await menu.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
    checks.record('clic droit : menu des outils au relâchement', opened);
    await page.keyboard.press('Escape');
    const closed = await menu.waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false);
    checks.record('menu des outils fermé par Échap', closed);

    const beforePan = await shot('avant-deplacement');
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 160, cy + 50, { steps: 12 });
    await page.mouse.up({ button: 'right' });
    const panned = await shot('deplacement');
    checks.record('glisser droit : pas de menu', !(await menu.isVisible()));
    changed('glisser droit : déplacement', beforePan, panned);

    const beforeZoom = await shot('avant-zoom');
    await page.evaluate(([x, y]) => {
      document.getElementById('canvas').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -9, deltaMode: WheelEvent.DOM_DELTA_LINE,
      }));
    }, [cx, cy]);
    changed('molette en lignes (Firefox) : zoom', beforeZoom, await shot('zoom'));

    const errors = backend === 'webgl' ? await glErrors() : [];
    checks.record('aucune erreur WebGL (getError)', !errors || errors.length === 0, errors?.join(', ') ?? 'contexte illisible');
    checks.record('aucune erreur de rendu en console', consoleFaults.length === 0, consoleFaults.slice(0, 3).join(' | '));
    checks.record('aucune exception', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    await sleep(1000); // reports leave asynchronously
    // The probes' own refused eval must have been reported (proof the report
    // channel works); anything else is a real violation.
    const reports = cspReports.slice(reportsBefore);
    const isProbeEval = (line) => /^script-src(-elem)? ← eval /.test(line);
    const violations = reports.filter((line) => !isProbeEval(line));
    checks.record(
      'CSP de production : aucune violation rapportée',
      violations.length === 0 && reports.some(isProbeEval),
      violations.length > 0 ? violations.slice(0, 4).join(' | ') : `${reports.length} rapport(s), tous ceux des sondes`,
    );
    return backend;
  } finally {
    await context.close();
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await readFile(join(args.dist, 'viewer.html')).catch(() => {
    throw new Error(`${args.dist}/viewer.html absent : lancer \`npm run build:vite\` avant`);
  });
  const tile = buildSyntheticLas(TILE);
  const server = await startServer(args.dist, tile);
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Tuile synthétique ${(tile.length / 1e6).toFixed(1)} Mo · ${origin} · ${process.platform}`);
  const summary = [];
  let failures = 0;
  try {
    for (const browserName of args.browsers) {
      let autoBackend = null;
      for (const engine of args.engines) {
        const label = `${browserName} / ${engine}`;
        console.log(`\n▶ ${label}`);
        if (engine === 'webgl' && autoBackend === 'webgl') {
          console.log('  ↷ sauté : le moteur automatique est déjà WebGL 2 dans ce navigateur (même chemin)');
          continue;
        }
        const checks = new Checks(label);
        try {
          const backend = await runCase(browserName, engine, args, origin, checks, server.cspReports);
          if (engine === 'auto' && checks.failed.length === 0) autoBackend = backend;
        } catch (error) {
          checks.record('exécution', false, String(error?.message ?? error).slice(0, 2000));
        }
        failures += checks.failed.length;
        summary.push({ browser: browserName, engine, platform: process.platform, results: checks.results });
      }
    }
  } finally {
    server.close();
  }
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(failures === 0 ? '\nTous les contrôles passent.' : `\n${failures} contrôle(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
