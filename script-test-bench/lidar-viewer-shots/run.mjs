/**
 * RedView Test-Bench : captures fixes du viewer LiDAR WebGPU (Edge headless + CDP)
 *
 * Comparaison visuelle avant/après d'un changement de rendu : sert un build
 * (`dist/` par défaut, `--dist <dossier>` pour un build gardé de côté), dépose
 * les tuiles COPC d'un dossier dans l'OPFS d'un profil Edge dédié (port fixe :
 * l'OPFS est par origine, les tuiles et leurs caches LOD restent d'un run à
 * l'autre), ouvre la scène avec `?bench=shots`, pose la caméra sur des vues
 * fixes et capture chaque vue une fois l'image au repos (boucle de rendu
 * arrêtée : chargements finis, budget et raffinement terminés).
 *
 * Usage :
 *   LIDAR_TILES_DIR=<dossier de .copc.laz IGN> [LIDAR_CENTER=965,6500] \
 *     node script-test-bench/lidar-viewer-shots/run.mjs --label avant \
 *     [--dist <dossier>] [--size 1920x1080] [--params "budget=6000000"] [--views ensemble,oblique] \
 *     [--keys t]   (touches envoyées au viewer avant les captures, ex. t = terrain masqué)
 *
 * Les PNG et un résumé JSON (statistiques du viewer par vue) vont dans
 * script-test-bench/reports/lidar-viewer-shots/<label>/.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPORT_DIR = join(ROOT, 'script-test-bench', 'reports', 'lidar-viewer-shots');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 18964);
const HTTP_PORT = Number(process.env.SHOTS_HTTP_PORT ?? 18971);
const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

/**
 * Poses dans le repère de rendu (x à l'est, z = −nord, mètres depuis le centre
 * de la scène), `extent` = plus grande dimension de la scène. La cible est au
 * sol.
 */
const VIEWS = {
  // Cadrage par défaut du visualiseur (toute la scène).
  ensemble: (e) => ({ theta: Math.PI / 4, phi: Math.PI / 3, radius: e * 0.72, at: [0, 0] }),
  // Vue de trois quarts à travers la scène : sol proche et tuiles lointaines.
  oblique: (e) => ({ theta: 0.9, phi: 1.12, radius: e * 0.3, at: [-e * 0.1, e * 0.07] }),
  // Bas au-dessus d'un bord, regardant à travers toute la scène (champ lointain).
  rasant: (e) => ({ theta: 2.5, phi: 1.36, radius: e * 0.2, at: [e * 0.18, e * 0.2] }),
  // Près du sol (pleine densité), en regardant assez vers le bas pour rester au-dessus des pentes raides.
  proche: (e) => ({ theta: 0.4, phi: 0.5, radius: e * 0.075, at: [e * 0.07, -e * 0.05] }),
};

function parseArgs(argv) {
  const args = { label: null, dist: join(ROOT, 'dist'), size: '1920x1080', params: '', views: Object.keys(VIEWS), keys: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') args.label = argv[++i];
    else if (arg === '--dist') args.dist = resolve(argv[++i]);
    else if (arg === '--size') args.size = argv[++i] ?? args.size;
    else if (arg === '--params') args.params = argv[++i] ?? '';
    else if (arg === '--views') args.views = (argv[++i] ?? '').split(',').filter((v) => v in VIEWS);
    else if (arg === '--keys') args.keys = argv[++i] ?? '';
  }
  if (!args.label) throw new Error('--label requis');
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(args) {
  const tilesDir = process.env.LIDAR_TILES_DIR;
  if (!tilesDir) throw new Error('LIDAR_TILES_DIR=<dossier de .copc.laz> requis');
  const tiles = [];
  for (const name of await readdir(tilesDir)) {
    const m = /^LHD_FXX_(\d+)_(\d+)_PTS_LAMB93_IGN69\.copc\.laz$/.exec(name);
    if (m) tiles.push({ name, x: Number(m[1]), y: Number(m[2]), size: (await stat(join(tilesDir, name))).size });
  }
  if (tiles.length === 0) throw new Error(`aucune tuile IGN dans ${tilesDir}`);
  const [cx, cy] = (process.env.LIDAR_CENTER ?? `${tiles[0].x},${tiles[0].y}`).split(',').map(Number);
  const primary = tiles.find((t) => t.x === cx && t.y === cy) ?? tiles[0];
  const others = tiles.filter((t) => t !== primary).slice(0, 8);
  await stat(join(args.dist, 'viewer.html')).catch(() => {
    throw new Error(`${args.dist}/viewer.html absent : lancer \`npm run build\` avant`);
  });

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const tile = path.startsWith('/__tiles/') ? tiles.find((t) => `/__tiles/${t.name}` === path) : null;
      if (tile) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tile.size });
        createReadStream(join(tilesDir, tile.name)).pipe(res);
        return;
      }
      const file = join(args.dist, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${HTTP_PORT}`;

  const [width, height] = args.size.split('x').map(Number);
  const flags = [
    '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(tmpdir(), 'redview-lidar-shots-profile')}`, `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${width},${height}`, '--force-device-scale-factor=1',
  ];
  const browser = spawn(EDGE, [...flags, 'about:blank'], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 80 && !targets; i++) {
      await sleep(250);
      targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null);
    }
    const page = targets?.find((t) => t.type === 'page');
    if (!page) throw new Error('Edge headless injoignable (CDP)');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const line = `[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`;
        logs.push(line);
        if (msg.params.type === 'error' || msg.params.type === 'warning' || line.includes('[LiDAR GPU]')) console.log(line.slice(0, 300));
      }
      if (msg.method === 'Runtime.exceptionThrown') console.log('[exception]', msg.params.exceptionDetails.exception?.description?.slice(0, 400));
    });
    const send = (method, params = {}) => new Promise((r) => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    // 1. Les tuiles vont dans OPFS comme le téléchargeur de l'application les stocke (gardées d'une exécution à l'autre).
    await send('Page.navigate', { url: `${origin}/favicon.ico` });
    await sleep(800);
    for (const tile of [primary, ...others]) {
      const stored = await evaluate(`(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('lidar-hd', { create: true });
        try {
          const existing = await (await dir.getFileHandle(${JSON.stringify(tile.name)})).getFile();
          if (existing.size === ${tile.size}) return 'déjà en cache';
        } catch {}
        const buf = await (await fetch('/__tiles/${tile.name}')).arrayBuffer();
        const fh = await dir.getFileHandle(${JSON.stringify(tile.name)}, { create: true });
        const w = await fh.createWritable(); await w.write(buf); await w.close();
        return buf.byteLength + ' o écrits';
      })()`);
      console.log(`Tuile ${tile.name} : ${stored}`);
    }
    await evaluate(`localStorage.removeItem('redview:lidar:route_overlay'), 'ok'`);

    // 2. Scene.
    const tileParams = others.map((t) => `&tile=${t.x},${t.y}`).join('');
    const extra = args.params ? `&${args.params}` : '';
    const t0 = Date.now();
    await send('Page.navigate', {
      url: `${origin}/viewer.html?x=${primary.x}&y=${primary.y}&crs=LAMB93&alt=IGN69${tileParams}&bench=shots${extra}`,
    });
    let ready = false;
    for (let i = 0; i < 2400 && !ready; i++) {
      await sleep(500);
      ready = await evaluate(`document.getElementById('overlay')?.classList.contains('hidden') === true && !!window.__rvLidarShots`).catch(() => false);
      if (i % 20 === 19) {
        const status = await evaluate(`document.getElementById('status-detail')?.textContent ?? ''`).catch(() => '');
        console.log(`  … ${((Date.now() - t0) / 1000).toFixed(0)} s ${status}`);
      }
    }
    if (!ready) throw new Error(`viewer pas prêt après ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(`Scène prête en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Seulement la vue 3D dans les captures.
    await evaluate(`(() => {
      const canvas = document.getElementById('canvas');
      for (const el of document.body.querySelectorAll('*')) {
        if (el === canvas || el.contains(canvas) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        el.style.setProperty('visibility', 'hidden', 'important');
      }
      return 'ok';
    })()`);

    for (const key of args.keys) {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key, text: type === 'keyDown' ? key : undefined, code: `Key${key.toUpperCase()}` });
      }
    }

    const outDir = join(REPORT_DIR, args.label);
    await mkdir(outDir, { recursive: true });
    const summary = { label: args.label, size: args.size, params: args.params, keys: args.keys, adapter: logs.find((l) => l.includes('Tier')) ?? null, views: {} };
    for (const view of args.views) {
      const extent = await evaluate('window.__rvLidarShots.extent');
      const pose = VIEWS[view](extent);
      const vt = Date.now();
      await evaluate(`(() => {
        const s = window.__rvLidarShots;
        const [x, z] = ${JSON.stringify(pose.at)};
        s.setPose({ theta: ${pose.theta}, phi: ${pose.phi}, radius: ${pose.radius}, targetX: x, targetY: s.groundAt(x, z), targetZ: z });
        return 'ok';
      })()`);
      // Qualité au repos : la boucle de rendu est arrêtée depuis un moment.
      let quietSince = 0;
      for (let i = 0; i < 600; i++) {
        await sleep(250);
        const st = await evaluate('window.__rvLidarShots.state()');
        if (!st.rendering && st.idle) {
          if (!quietSince) quietSince = Date.now();
          if (Date.now() - quietSince > 1200) break;
        } else {
          quietSince = 0;
        }
      }
      const settleMs = Date.now() - vt;
      const state = await evaluate('window.__rvLidarShots.state()');
      const statsText = await evaluate(`document.getElementById('stats')?.textContent ?? ''`);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(outDir, `${view}.png`), Buffer.from(shot.result.data, 'base64'));
      summary.views[view] = { settleMs, stats: state.stats, statsText };
      console.log(`${view} : ${(settleMs / 1000).toFixed(1)} s · ${statsText}`);
    }
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`Captures : ${outDir}`);
    ws.close();
  } finally {
    if (process.platform === 'win32' && browser.pid) {
      spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      browser.kill();
    }
    server.close();
  }
}

try {
  await run(parseArgs(process.argv.slice(2)));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
