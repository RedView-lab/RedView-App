// Real terrain for the before/after image: IGN LiDAR HD bare-earth DTM from
// the Géoplateforme WMS-R, Lambert 93, float32 BIL. Cached in the bench
// reports folder (git-ignored) so the image can be rebuilt offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WMS = 'https://data.geopf.fr/wms-r/wms';
const LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93';

export interface IgnDem {
  data: Float32Array;
  width: number;
  height: number;
  /** Lambert 93 bounds of the node grid. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface IgnDemWgs84 {
  data: Float32Array;
  width: number;
  height: number;
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
}

/** Coarse RGE ALTI over a WGS84 box (cell grid, row 0 = south), for the model orography and the far field. */
export async function fetchIgnDemWgs84(lonMin: number, latMin: number, lonMax: number, latMax: number, width: number, height: number, cacheDir: string): Promise<IgnDemWgs84> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `ignw-${lonMin}-${latMin}-${lonMax}-${latMax}-${width}x${height}.f32`);
  let raw: Float32Array;
  if (existsSync(file)) {
    const buf = readFileSync(file);
    raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
  } else {
    const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=`
      + `&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:4326&BBOX=${[latMin, lonMin, latMax, lonMax].join(',')}&WIDTH=${width}&HEIGHT=${height}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IGN WMS HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength !== width * height * 4) throw new Error(`IGN WMS: ${buf.byteLength} bytes`);
    raw = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) raw[i] = buf.readFloatLE(i * 4);
    writeFileSync(file, Buffer.from(raw.buffer));
  }
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) data.set(raw.subarray((height - 1 - y) * width, (height - y) * width), y * width);
  // Outside France the service answers a no-data value: fill with the mean.
  let s = 0, k = 0;
  for (const v of data) if (v > -500 && v < 9000) { s += v; k++; }
  for (let i = 0; i < data.length; i++) if (!(data[i] > -500 && data[i] < 9000)) data[i] = k > 0 ? s / k : 0;
  return { data, width, height, lonMin, latMin, lonMax, latMax };
}

/** Bilinear height of a WGS84 point in a cell-centred grid. */
export function sampleWgs84(d: IgnDemWgs84, lon: number, lat: number): number {
  const fx = ((lon - d.lonMin) / (d.lonMax - d.lonMin)) * d.width - 0.5;
  const fy = ((lat - d.latMin) / (d.latMax - d.latMin)) * d.height - 0.5;
  const x = Math.min(d.width - 2, Math.max(0, Math.floor(fx)));
  const y = Math.min(d.height - 2, Math.max(0, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x));
  const ty = Math.min(1, Math.max(0, fy - y));
  const i = y * d.width + x;
  const a = d.data[i] + (d.data[i + 1] - d.data[i]) * tx;
  const b = d.data[i + d.width] + (d.data[i + d.width + 1] - d.data[i + d.width]) * tx;
  return a + (b - a) * ty;
}

/**
 * Node grid of n × n over [minX, maxX] × [minY, maxY] (row 0 = south). The WMS
 * resamples nearest-neighbour: asked 4× finer, then box-averaged.
 */
export async function fetchIgnDem(minX: number, minY: number, maxX: number, maxY: number, n: number, cacheDir: string): Promise<IgnDem> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `ign-${minX}-${minY}-${maxX}-${maxY}-${n}.f32`);
  let raw: Float32Array;
  if (existsSync(file)) {
    const buf = readFileSync(file);
    raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
  } else {
    const k = 4;
    const m = n * k;
    // WMS pixels are cells: widen by half a node so each k×k block centres on a node.
    const cell = (maxX - minX) / (n - 1);
    const bbox = [minX - cell / 2, minY - cell / 2, maxX + cell / 2, maxY + cell / 2].join(',');
    const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(LAYER)}&STYLES=`
      + `&FORMAT=${encodeURIComponent('image/x-bil;bits=32')}&CRS=EPSG:2154&BBOX=${bbox}&WIDTH=${m}&HEIGHT=${m}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IGN WMS HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength !== m * m * 4) throw new Error(`IGN WMS: ${buf.byteLength} bytes, expected ${m * m * 4} (${buf.subarray(0, 200).toString()})`);
    raw = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let s = 0;
        for (let b = 0; b < k; b++) for (let a = 0; a < k; a++) s += buf.readFloatLE(((y * k + b) * m + x * k + a) * 4);
        raw[y * n + x] = s / (k * k);
      }
    }
    writeFileSync(file, Buffer.from(raw.buffer));
  }
  // WMS rows run north → south: flip to row 0 = south.
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) data.set(raw.subarray((n - 1 - y) * n, (n - y) * n), y * n);
  return { data, width: n, height: n, minX, minY, maxX, maxY };
}
