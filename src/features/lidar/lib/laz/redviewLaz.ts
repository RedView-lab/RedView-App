/**
 * COPC chunk decoding with the RedView LAZ decoder (vendor/redviewlaz: laz-rs
 * compiled to WASM). LAZ 1.4 point formats 6–8 compress each field in its
 * own layer: only X/Y/Z, classification, intensity and RGB are decompressed,
 * GPS time, scan angle, point source, user data and flags are skipped. On IGN
 * LiDAR HD tiles that halves the decoding time of laz-perf, with the same
 * output byte for byte (`decodeCopcChunks` stays as the fallback).
 *
 * The module is compiled once on the main thread (`redviewLazModule.ts`) and
 * instantiated here, in each decode worker (Firefox's CSP refuses compiling
 * WebAssembly inside a worker).
 */
import type { PointCloudOrigin } from '../../types';
import type { CopcChunk, CopcDecodeHeader, DecodedCopcChunks } from '../lazParser';
import { CopcDecoder, initSync } from './pkg/redviewlaz.js';

let instantiatedWith: WebAssembly.Module | null = null;

export function initRedviewLaz(module: WebAssembly.Module): void {
  if (instantiatedWith === module) return;
  initSync({ module });
  instantiatedWith = module;
}

/** Same contract as `decodeCopcChunks` (lazParser.ts); needs `initRedviewLaz` first. */
export function decodeCopcChunksWithRedviewLaz(
  header: CopcDecodeHeader,
  chunks: readonly CopcChunk[],
  origin: PointCloudOrigin,
  onChunk?: (done: number, total: number) => void,
): DecodedCopcChunks {
  const [ox, oy, oz] = header.offset as [number, number, number];
  const decoder = new CopcDecoder(
    header.pointDataRecordFormat,
    header.pointDataRecordLength,
    Float64Array.from(header.scale),
    // Same float64 terms as decodeCopcChunks: X · scale + (offset − origin).
    Float64Array.of(ox - origin.x, oy - origin.y, oz - origin.z),
  );
  try {
    for (let c = 0; c < chunks.length; c++) {
      decoder.decode(chunks[c]!.bytes, chunks[c]!.pointCount);
      onChunk?.(c + 1, chunks.length);
    }
    const count = chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0);
    const positions = decoder.take_positions();
    if (positions.length !== count * 3) throw new Error(`COPC : ${positions.length / 3} points décodés sur ${count}`);
    const format = header.pointDataRecordFormat & 0x3f;
    const colors = decoder.take_colors();
    const [minX, minY, minZ, maxX, maxY, maxZ] = decoder.bounds() as unknown as [number, number, number, number, number, number];
    return {
      positions,
      classifications: decoder.take_classifications(),
      intensities: decoder.take_intensities(),
      colors: format === 7 || format === 8 ? colors : null,
      maxRgb: decoder.max_rgb(),
      count,
      bounds: {
        minX: minX + origin.x, minY: minY + origin.y, minZ: minZ + origin.z,
        maxX: maxX + origin.x, maxY: maxY + origin.y, maxZ: maxZ + origin.z,
      },
    };
  } finally {
    decoder.free();
  }
}
