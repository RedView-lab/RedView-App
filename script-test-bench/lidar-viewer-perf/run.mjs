/**
 * RedView Test-Bench : cadence réelle du viewer LiDAR WebGPU (Edge headless + CDP)
 *
 * Sert `dist/` (lancer `npm run build` avant), dépose une vraie tuile COPC
 * dans l'OPFS d'un profil Edge dédié (gardé entre deux runs, avec le cache
 * LOD), ouvre `viewer.html?…&bench=orbit` et récupère le rapport du parcours
 * caméra scripté (src/features/lidar/viewer/perf/viewerBench.ts) : fps réels,
 * p50/p95 de l'intervalle entre frames, part de vsync ratées, coût GPU des
 * passes de dessin et d'ombrage, temps JS, points affichés, blocs chargés.
 *
 * Pour comparer deux variantes (A/B), figer le budget (`--params budget=…`) :
 * à charge égale, seul le coût GPU change. Le GPU baisse sa fréquence quand
 * il a de la marge, donc un écart de « GPU ms » sous 60 fps se lit avec les
 * frames ratées. Sans vsync (--disable-gpu-vsync) Edge headless empile les
 * frames sans attendre le GPU : la cadence mesurée n'y veut rien dire.
 * `?mscale=1&msquare=0` désactive la qualité réduite en mouvement.
 * `--route N` injecte une trace de N points comme le fait l'app (coût de
 * l'overlay de route).
 *
 * Usage :
 *   LIDAR_TILE=<fichier .copc.laz> [LIDAR_TILE_XY=965,6500] npm run bench:lidar-fps -- \
 *     [--label avant] [--params "budget=1500000&mscale=1"] [--size 1600x900] [--route 20000] [--dist <build>]
 *   npm run bench:lidar-fps -- --compare avant,apres
 * `--quota <Mo>` force le quota de stockage de l'origine (CDP) : disque plein,
 * cache LOD impossible à écrire.
 * `--cold` efface d'abord les caches dérivés des tuiles (LOD, terrain) pour
 * mesurer une première ouverture (décodage, colorisation, relief, octree) ;
 * la chronologie des étapes de chargement est imprimée et gardée dans le rapport.
 * `LIDAR_TILES_DIR=<dossier>` (à la place de LIDAR_TILE) ouvre une scène de
 * plusieurs tuiles IGN voisines (jusqu'à 9, centre LIDAR_TILE_XY ou la première) ;
 * profil Edge et port HTTP sont fixes (une origine OPFS par profil) : tuiles et
 * caches LOD sont gardés d'un run à l'autre (un port aléatoire créait une
 * origine, donc ~0,5 Go d'OPFS, à chaque run).
 *
 * Les rapports JSON vont dans script-test-bench/reports/lidar-viewer-perf/<label>.json.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPORT_DIR = join(ROOT, 'script-test-bench', 'reports', 'lidar-viewer-perf');
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 18962);
const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const args = { label: null, params: '', size: '1600x900', compare: null, route: 0, dist: join(ROOT, 'dist'), cold: false, quotaMb: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') args.label = argv[++i];
    else if (arg === '--params') args.params = argv[++i] ?? '';
    else if (arg === '--size') args.size = argv[++i] ?? args.size;
    else if (arg === '--compare') args.compare = (argv[++i] ?? '').split(',');
    else if (arg === '--route') args.route = Number(argv[++i] ?? 0);
    else if (arg === '--dist') args.dist = resolve(argv[++i]);
    else if (arg === '--cold') args.cold = true;
    else if (arg === '--quota') args.quotaMb = Number(argv[++i]);
  }
  return args;
}

/** Lambert-93 → WGS84 (GRS80, conique conforme de Lambert inverse), assez pour placer une route synthétique. */
function lambert93ToWgs84(x, y) {
  const a = 6378137;
  const e = 0.0818191910428158;
  const deg = Math.PI / 180;
  const [phi0, phi1, phi2, lambda0] = [46.5 * deg, 44 * deg, 49 * deg, 3 * deg];
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const rho0 = a * F * t(phi0) ** n;
  const dx = x - 700000;
  const dy = rho0 - (y - 6600000);
  const rho = Math.sign(n) * Math.hypot(dx, dy);
  const tt = (rho / (a * F)) ** (1 / n);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 8; i++) {
    phi = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
  }
  return { lat: phi / deg, lon: (Math.atan2(dx, dy) / n + lambda0) / deg };
}

/**
 * État de la surcouche de route tel que l'application le stocke
 * (lib/routeOverlaySync.ts) : une ligne droite de 200 km de `count` points
 * passant par le centre de la tuile, donc la plupart des points sont hors de la
 * scène, comme pour un vrai itinéraire.
 */
function syntheticRouteState(count, xKm, yKm) {
  const cx = xKm * 1000 + 500;
  const cy = yKm * 1000 - 500;
  const points = [];
  for (let i = 0; i < count; i++) {
    const s = i / Math.max(1, count - 1) - 0.5;
    points.push(lambert93ToWgs84(cx + s * 160_000, cy + s * 120_000));
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: 'redview_app',
    routes: [{ id: 'bench-route', name: 'Bench', color: '#ff3b30', opacity: 1, visible: true, points }],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (ratio) => `${(ratio * 100).toFixed(1)} %`;

/**
 * Étapes de chargement du visualiseur telles que l'utilisateur les voit (l'état
 * détaillé gardé dans le title de `#status`), enregistrées dans la page dès son
 * premier script, plus le moment où la surcouche de chargement se masque.
 */
const LOAD_LOG_SCRIPT = `(() => {
  const log = window.__rvLoadLog = [];
  let last = '';
  const observer = new MutationObserver(() => {
    const status = document.getElementById('status');
    const msg = status ? (status.getAttribute('title') || status.textContent || '') : '';
    if (msg && msg !== last) { last = msg; log.push([Math.round(performance.now()), msg]); }
    if (document.getElementById('overlay')?.classList.contains('hidden')) {
      window.__rvReadyAt = Math.round(performance.now());
      observer.disconnect();
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

/** Étapes avec leur début et leur durée ; les messages consécutifs d'une même étape (compteurs de progression) sont fusionnés. */
function loadPhases(log, readyAt) {
  const phases = [];
  for (const [t, msg] of log) {
    const step = msg.replace(/\d+\/\d+(\.\.\.)?/g, '#').replace(/\d+([.,]\d+)?\s*%/g, '#');
    const lastPhase = phases[phases.length - 1];
    if (lastPhase && lastPhase.step === step) continue;
    phases.push({ startMs: t, step });
  }
  return phases.map((phase, i) => ({ ...phase, durationMs: (phases[i + 1]?.startMs ?? readyAt ?? phase.startMs) - phase.startMs }));
}

function printLoad(load) {
  console.log(`\nChargement${load.cold ? ' à froid' : ''} : viewer prêt à ${(load.readyMs / 1000).toFixed(2)} s`);
  console.table(load.phases.map((p) => ({ 'début s': (p.startMs / 1000).toFixed(2), 'durée s': (p.durationMs / 1000).toFixed(2), 'étape': p.step.slice(0, 90) })));
}

function printReport(report) {
  console.log(`\n${report.meta.label ?? '(sans label)'} · ${report.meta.size}` +
    `${report.meta.route ? ` · trace ${report.meta.route} pts` : ''}` +
    `${report.meta.params ? ` · ${report.meta.params}` : ''} · écran ${(1000 / report.result.refreshMs).toFixed(0)} Hz`);
  if (report.meta.adapter) console.log(report.meta.adapter);
  const rows = [];
  for (const pass of report.result.passes) {
    for (const s of [...pass.segments, pass.total]) {
      rows.push({
        passe: pass.pass,
        segment: s.segment,
        frames: s.frames,
        fps: s.fps,
        'p50 ms': s.p50Ms,
        'p95 ms': s.p95Ms,
        'max ms': s.maxMs,
        'ratées': pct(s.missedRatio),
        'GPU ms': s.drawMs,
        'ombrage ms': s.shadeMs,
        'CPU ms': s.cpuMs,
        'points M': Number((s.points / 1e6).toFixed(2)),
        'budget M': Number((s.budget / 1e6).toFixed(2)),
        blocs: s.uploads,
      });
    }
  }
  console.table(rows);
}

async function compare(labels) {
  const reports = await Promise.all(labels.map(async (label) => JSON.parse(await readFile(join(REPORT_DIR, `${label}.json`), 'utf8'))));
  const keys = [['fps', 'fps'], ['p95Ms', 'p95 ms'], ['missedRatio', 'ratées'], ['drawMs', 'GPU ms'], ['shadeMs', 'ombrage ms'], ['cpuMs', 'CPU ms'], ['points', 'points']];
  const rows = [];
  for (const passIndex of [0, 1]) {
    const segmentNames = reports[0].result.passes[passIndex].segments.map((s) => s.segment).concat('total');
    for (const name of segmentNames) {
      const row = { passe: reports[0].result.passes[passIndex].pass, segment: name };
      for (const [key, title] of keys) {
        row[title] = reports.map((r) => {
          const pass = r.result.passes[passIndex];
          const s = name === 'total' ? pass.total : pass.segments.find((seg) => seg.segment === name);
          if (!s) return '—';
          if (key === 'missedRatio') return pct(s[key]);
          if (key === 'points') return (s[key] / 1e6).toFixed(2);
          return s[key];
        }).join(' → ');
      }
      rows.push(row);
    }
  }
  console.log(`\n${labels.join(' → ')}`);
  console.table(rows);
}

/** Tuiles de l'exécution : un fichier (LIDAR_TILE) ou les tuiles IGN d'un dossier (LIDAR_TILES_DIR, le centre d'abord). */
async function benchTiles() {
  const dir = process.env.LIDAR_TILES_DIR;
  if (dir) {
    const tiles = [];
    for (const name of await readdir(dir)) {
      const m = /^LHD_FXX_(\d+)_(\d+)_PTS_LAMB93_IGN69\.copc\.laz$/.exec(name);
      if (m) tiles.push({ path: join(dir, name), name, x: Number(m[1]), y: Number(m[2]), size: (await stat(join(dir, name))).size });
    }
    if (tiles.length === 0) throw new Error(`aucune tuile IGN dans ${dir}`);
    const [cx, cy] = (process.env.LIDAR_TILE_XY ?? `${tiles[0].x},${tiles[0].y}`).split(',').map(Number);
    const primary = tiles.find((t) => t.x === cx && t.y === cy) ?? tiles[0];
    return [primary, ...tiles.filter((t) => t !== primary).slice(0, 8)];
  }
  const tilePath = process.env.LIDAR_TILE;
  if (!tilePath) throw new Error('LIDAR_TILE=<fichier .copc.laz> ou LIDAR_TILES_DIR=<dossier> requis');
  const xy = process.env.LIDAR_TILE_XY ?? /LHD_FXX_(\d+)_(\d+)_/.exec(basename(tilePath))?.slice(1, 3).join(',');
  if (!xy) throw new Error('LIDAR_TILE_XY=<x>,<y> requis (nom de fichier non IGN)');
  const [x, y] = xy.split(',').map(Number);
  const name = `LHD_FXX_${String(x).padStart(4, '0')}_${y}_PTS_LAMB93_IGN69.copc.laz`;
  return [{ path: tilePath, name, x, y, size: (await stat(tilePath)).size }];
}

async function run(args) {
  const tiles = await benchTiles();
  const multi = !!process.env.LIDAR_TILES_DIR;
  const { x: xKm, y: yKm } = tiles[0];
  await stat(join(args.dist, 'viewer.html')).catch(() => {
    throw new Error(`${args.dist}/viewer.html absent : lancer \`npm run build\` avant le bench`);
  });

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const tile = path.startsWith('/__bench-tiles/') ? tiles.find((t) => `/__bench-tiles/${t.name}` === path) : null;
      if (tile) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tile.size });
        createReadStream(tile.path).pipe(res);
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
  // Origine fixe (OPFS est par origine) : les tuiles et leurs caches sont
  // réutilisés, et les exécutions n'empilent jamais une origine chacune dans le
  // profil.
  await new Promise((r) => server.listen(Number(process.env.PERF_HTTP_PORT ?? (multi ? 18972 : 18973)), '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const [width, height] = args.size.split('x').map(Number);
  const flags = [
    '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(tmpdir(), multi ? 'redview-lidar-perf-scene-profile' : 'redview-lidar-perf-profile')}`, `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${width},${height}`,
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
        if (msg.params.type === 'error' || msg.params.type === 'warning') console.log(line.slice(0, 300));
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
    if (args.quotaMb) {
      // Un petit disque : les tuiles peuvent tenir, leurs caches LOD non (le visualiseur diffuse alors depuis la mémoire).
      await send('Storage.overrideQuotaForOrigin', { origin, quotaSize: args.quotaMb * 1024 * 1024 });
      console.log(`Quota de stockage forcé : ${args.quotaMb} Mo`);
    }

    // 1. Les tuiles vont dans OPFS comme le téléchargeur de l'application les stocke (gardées d'une exécution à l'autre).
    await send('Page.navigate', { url: `${origin}/favicon.ico` });
    await sleep(800);
    for (const tile of tiles) {
      const stored = await evaluate(`(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('lidar-hd', { create: true });
        try {
          const existing = await (await dir.getFileHandle(${JSON.stringify(tile.name)})).getFile();
          if (existing.size === ${tile.size}) return 'déjà en cache';
        } catch {}
        const buf = await (await fetch(${JSON.stringify(`/__bench-tiles/${tile.name}`)})).arrayBuffer();
        const fh = await dir.getFileHandle(${JSON.stringify(tile.name)}, { create: true });
        const w = await fh.createWritable(); await w.write(buf); await w.close();
        return buf.byteLength + ' o écrits';
      })()`);
      console.log(`Tuile ${tile.name} : ${stored}`);
    }
    if (args.cold) {
      // Chaque cache dérivé de ce profil : le visualiseur les indexe sur le nom
      // de tuile de sa propre convention (y + 1 km pour les noms IGN écrits ici).
      const removed = await evaluate(`(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lidar-hd', { create: true });
        const names = [];
        for await (const name of dir.keys()) names.push(name);
        const removed = names.filter((name) => /\\.(lod_v|terrain_hd_v|colorized_v)\\d/.test(name));
        for (const name of removed) await dir.removeEntry(name, { recursive: true });
        return removed;
      })()`);
      console.log(`À froid : ${removed.length} cache(s) dérivé(s) effacé(s)${removed.length ? ` (${removed.join(', ')})` : ''}`);
    }
    const routeState = args.route > 0 ? JSON.stringify(syntheticRouteState(args.route, xKm, yKm)) : null;
    await evaluate(routeState
      ? `localStorage.setItem('redview:lidar:route_overlay', ${JSON.stringify(routeState)}), 'ok'`
      : `localStorage.removeItem('redview:lidar:route_overlay'), 'ok'`);
    if (routeState) console.log(`Trace synthétique : ${args.route} points`);

    // 2. Visualiseur avec le parcours scripté.
    const extra = args.params ? `&${args.params}` : '';
    await send('Page.addScriptToEvaluateOnNewDocument', { source: LOAD_LOG_SCRIPT });
    const t0 = Date.now();
    const tileParams = tiles.slice(1).map((t) => `&tile=${t.x},${t.y}`).join('');
    await send('Page.navigate', { url: `${origin}/viewer.html?x=${xKm}&y=${yKm}&crs=LAMB93&alt=IGN69${tileParams}&bench=orbit${extra}` });
    let ready = false;
    for (let i = 0; i < 600 && !ready; i++) {
      await sleep(500);
      ready = await evaluate(`document.getElementById('overlay')?.classList.contains('hidden') === true`).catch(() => false);
    }
    if (!ready) throw new Error(`viewer pas prêt après ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const loadLog = await evaluate('({ log: window.__rvLoadLog ?? [], readyAt: window.__rvReadyAt ?? null })');
    const load = { cold: args.cold, readyMs: loadLog.readyAt, phases: loadPhases(loadLog.log, loadLog.readyAt) };
    printLoad(load);
    console.log(`Viewer prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s, parcours en cours…`);
    let result = null;
    for (let i = 0; i < 240 && !result; i++) {
      await sleep(500);
      result = await evaluate('window.__rvLidarBench ?? null').catch(() => null);
    }
    if (!result) throw new Error('rapport de bench absent (window.__rvLidarBench)');
    ws.close();

    const report = {
      meta: {
        label: args.label,
        date: new Date().toISOString(),
        route: args.route,
        tiles: tiles.length,
        size: args.size,
        params: args.params,
        adapter: logs.find((line) => line.includes('[LiDAR GPU] Tier')) ?? null,
      },
      load,
      result,
    };
    printReport(report);
    if (args.label) {
      await mkdir(REPORT_DIR, { recursive: true });
      const out = join(REPORT_DIR, `${args.label}.json`);
      await writeFile(out, JSON.stringify(report, null, 2));
      console.log(`Rapport : ${out}`);
    }
  } finally {
    // Tue tout l'arbre : sous Windows, `kill()` ne termine que le processus du
    // navigateur, et ses enfants GPU / rendu peuvent traîner.
    if (process.platform === 'win32' && browser.pid) {
      spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      browser.kill();
    }
    server.close();
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.compare) await compare(args.compare);
  else await run(args);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
