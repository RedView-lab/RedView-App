// Sanity-check the TIFF LZW decoder against a real swissSURFACE3D Raster COG.
// Run: node scripts/test-swiss-lzw.mjs
import fs from 'node:fs';
import https from 'node:https';

const src = fs.readFileSync('public/sw-dem/swiss-cog.js', 'utf8');
// Find decodeTIFFLZW by brace-balanced extraction
const start = src.indexOf('function decodeTIFFLZW');
if (start < 0) { console.error('decoder marker not found'); process.exit(1); }
let i = src.indexOf('{', start);
let depth = 1; let p = i + 1;
while (p < src.length && depth > 0) {
  const c = src[p];
  if (c === '{') depth++;
  else if (c === '}') depth--;
  p++;
}
const body = src.slice(start, p);
const decodeTIFFLZW = new Function(`${body}; return decodeTIFFLZW;`)();

const url = 'https://data.geo.admin.ch/ch.swisstopo.swisssurface3d-raster/swisssurface3d-raster_2021_2612-1092/swisssurface3d-raster_2021_2612-1092_0.5_2056_5728.tif';

function rangeFetch(off, len) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

const head = await rangeFetch(0, 32768);
const buf = head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength);
const dv = new DataView(buf);
const ifd0 = dv.getUint32(4, true);
const n = dv.getUint16(ifd0, true);
let tileOffOff = 0; let tileBcOff = 0;
for (let i = 0; i < n; i++) {
  const eo = ifd0 + 2 + i * 12;
  const tag = dv.getUint16(eo, true);
  const val = dv.getUint32(eo + 8, true);
  if (tag === 324) tileOffOff = val;
  if (tag === 325) tileBcOff = val;
}
const t0Off = dv.getUint32(tileOffOff, true);
const t0Bc = dv.getUint32(tileBcOff, true);
console.log('Tile 0:', { offset: t0Off, bytes: t0Bc });

const compressed = await rangeFetch(t0Off, t0Bc);
console.log('Compressed:', compressed.length);

const out = decodeTIFFLZW(new Uint8Array(compressed));
console.log('Decompressed:', out.length, 'expected', 512 * 512 * 4);

if (out.length >= 512 * 512 * 4) {
  const f32 = new Float32Array(out.buffer, out.byteOffset, 512 * 512);
  console.log('Corners:', { tl: f32[0], tr: f32[511], bl: f32[512 * 511], br: f32[512 * 512 - 1] });
  console.log('Center:', f32[256 * 512 + 256]);
  let mn = Infinity; let mx = -Infinity; let nonZero = 0; let nan = 0;
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    if (Number.isNaN(v)) nan++;
    else { if (v !== 0) nonZero++; if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  console.log({ min: mn, max: mx, nonZero, nan });
}
