const WMS = 'https://data.geopf.fr/wms-r/wms';
const L = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const R = 6378137;
function mb(z, x, y) { const n = 1 << z, s = (2 * Math.PI * R) / n; return { minx: -Math.PI * R + x * s, maxx: -Math.PI * R + (x + 1) * s, miny: Math.PI * R - (y + 1) * s, maxy: Math.PI * R - y * s }; }
const t = { z: 14, x: 8467, y: 5890 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqY = (f, w, h) => { let e = 0, tt = 0; for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { tt++; if (f[y * w + x] === f[(y - 1) * w + x]) e++; } return 100 * e / tt; };
const dist = (f, w, h) => { const s = new Set(); for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k = (k * 31 + Math.round(f[y * w + x] * 100)) | 0; s.add(k); } return s.size; };
const comb = (f, w, h) => { const d = []; for (let y = 0; y + 1 < h; y++) { let s = 0, c = 0; for (let x = 0; x < w; x++) { const v = Math.abs(f[(y + 1) * w + x] - f[y * w + x]); if (Number.isFinite(v)) { s += v; c++; } } d.push(c ? s / c : 0); } let ev = 0, ne = 0, od = 0, no = 0; d.forEach((v, i) => { if (i % 2 === 0) { ev += v; ne++; } else { od += v; no++; } }); const a = ev / ne, b = od / no; return Math.abs(a - b) / (((a + b) / 2) || 1); };
const m = mb(t.z, t.x, t.y);
const cases = [
  ['4326 256x256', 'CRS=EPSG:4326&BBOX=45.04248,6.04248,45.05800,6.06445', 256, 256],
  ['3857 256x256', `CRS=EPSG:3857&BBOX=${[m.minx, m.miny, m.maxx, m.maxy].join(',')}`, 256, 256],
  ['3857 512x512', `CRS=EPSG:3857&BBOX=${[m.minx, m.miny, m.maxx, m.maxy].join(',')}`, 512, 512],
  ['3857 724x512', `CRS=EPSG:3857&BBOX=${[m.minx, m.miny, m.maxx, m.maxy].join(',')}`, 724, 512],
];
for (const [label, bb, w, h] of cases) {
  const u = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(L)}&STYLES=&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&${bb}&WIDTH=${w}&HEIGHT=${h}`;
  let f = null;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'redview-probe' } });
    if (r.status === 429) { await sleep(1400 * (i + 1)); continue; }
    if (!r.ok) { console.log(label, 'HTTP', r.status); break; }
    const b = await r.arrayBuffer();
    if (b.byteLength === w * h * 4) f = new Float32Array(b);
    break;
  }
  await sleep(1400);
  if (!f) { console.log(label, '-> no data'); continue; }
  console.log(`${label.padEnd(14)} eqY=${eqY(f, w, h).toFixed(2)}% distinctRows=${dist(f, w, h)}/${h} comb=${comb(f, w, h).toFixed(3)}`);
}
