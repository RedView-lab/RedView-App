export function encodeShadowRgba(
  shadow: Uint8Array,
  W: number,
  H: number,
  shadowStrength: number,
  nightFloor: number,
): Uint8Array {
  const strength = Math.max(0, Math.min(1, shadowStrength));
  const floor = (Math.max(0, Math.min(1, nightFloor)) * 255) | 0;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < shadow.length; i++) {
    const coverage = shadow[i] / 255;
    const cast = Math.round(Math.pow(coverage, 0.82) * 224 * strength);
    const a = cast > floor ? cast : floor;
    if (a === 0) continue;
    const o = i * 4;
    rgba[o + 3] = a;
  }
  return rgba;
}

export function lngLatToMercTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = ((lng + 180) / 360) * n;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
  return { x, y };
}

export function latToMercY(lat: number): number {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

export function rawPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateStored(raw);
  const adler = adler32(raw);
  const zlib = new Uint8Array(2 + compressed.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib.set(compressed, 2);
  zlib[zlib.length - 4] = (adler >>> 24) & 0xff;
  zlib[zlib.length - 3] = (adler >>> 16) & 0xff;
  zlib[zlib.length - 2] = (adler >>> 8) & 0xff;
  zlib[zlib.length - 1] = adler & 0xff;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', zlib);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}

function writeU32(buf: Uint8Array, off: number, v: number) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  writeU32(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  writeU32(out, 8 + data.length, crc);
  return out;
}

function deflateStored(data: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const blocks = Math.ceil(data.length / MAX) || 1;
  const out = new Uint8Array(blocks * 5 + data.length);
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const end = Math.min(start + MAX, data.length);
    const len = end - start;
    out[off++] = i === blocks - 1 ? 0x01 : 0x00;
    out[off++] = len & 0xff;
    out[off++] = (len >>> 8) & 0xff;
    out[off++] = (~len) & 0xff;
    out[off++] = ((~len) >>> 8) & 0xff;
    out.set(data.subarray(start, end), off);
    off += len;
  }
  return out.subarray(0, off);
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}