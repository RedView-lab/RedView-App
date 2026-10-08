/**
 * Décodage des chunks COPC avec le décodeur LAZ de RedView (vendor/redviewlaz :
 * laz-rs compilé en WASM). Les formats de point LAZ 1.4 6–8 compressent chaque
 * champ dans sa propre couche : seuls X/Y/Z, la classification, l'intensité et
 * le RVB sont décompressés ; le temps GPS, l'angle de scan, la source du point,
 * les données utilisateur et les drapeaux sont sautés. Sur les tuiles IGN LiDAR
 * HD, cela divise par deux le temps de décodage de laz-perf, pour une sortie
 * identique octet pour octet (`decodeCopcChunks` reste le repli).
 *
 * Le module est compilé une fois sur le thread principal (`redviewLazModule.ts`)
 * et instancié ici, dans chaque worker de décodage (la CSP de Firefox refuse de
 * compiler du WebAssembly dans un worker).
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

/** Même contrat que `decodeCopcChunks` (lazParser.ts) ; nécessite `initRedviewLaz` avant. */
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
    // Mêmes termes float64 que decodeCopcChunks : X · scale + (offset − origin).
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
