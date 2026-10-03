/**
 * Fusion de plusieurs nuages LAS/LAZ d'une même emprise en un seul LAS 1.2
 * non compressé (format de point 0, 20 o/point) — les cellules DHMV II de
 * Flandre sont publiées en morceaux de bandes de vol qui se recouvrent.
 *
 * Le format 0 garde tout ce que lit le viewer (X/Y/Z, intensité, retours,
 * classe, angle, source) : les formats 0–5 partagent ces 20 premiers octets,
 * seuls X/Y/Z sont réécrits dans l'échelle / l'origine du fichier fusionné.
 * Aucun encodeur LAZ n'est disponible côté navigateur : le fichier reste brut
 * (~150 Mo pour une cellule médiane), le viewer en tire ensuite son cache LOD.
 */

const HEADER_SIZE = 227;
const VLR_HEADER_SIZE = 54;
const RECORD_LENGTH = 20;
const MIN_SCALE = 0.001;

export interface LasMergeOptions {
  /** Origine des entiers X/Y du fichier fusionné (coin de l'emprise). */
  offsetX: number;
  offsetY: number;
  /** EPSG horizontal et vertical, écrits en GeoKeyDirectory (lecture par les outils SIG). */
  horizontalEpsg: number;
  verticalEpsg?: number;
  /** Au-delà, éclaircissement uniforme (Bresenham, dans l'ordre des fichiers). */
  maxPoints: number;
  systemIdentifier: string;
}

interface SourceHeader {
  pointCount: number;
  pointDataRecordFormat: number;
  pointDataRecordLength: number;
  pointDataOffset: number;
  scale: readonly number[];
  offset: readonly number[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LazPerf = any;

function writeAscii(bytes: Uint8Array, at: number, length: number, text: string): void {
  for (let i = 0; i < length; i++) bytes[at + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0;
}

/** VLR GeoKeyDirectory (34735) : modèle projeté, EPSG horizontal (et vertical). */
function geoKeyVlr(horizontalEpsg: number, verticalEpsg?: number): Uint8Array {
  const keys: number[][] = [
    [1024, 0, 1, 1], // GTModelTypeGeoKey = projeté
    [1025, 0, 1, 1], // GTRasterTypeGeoKey = PixelIsArea
    [3072, 0, 1, horizontalEpsg], // ProjectedCSTypeGeoKey
  ];
  if (verticalEpsg) keys.push([4096, 0, 1, verticalEpsg]); // VerticalCSTypeGeoKey
  const shorts = [1, 1, 0, keys.length, ...keys.flat()];
  const out = new Uint8Array(VLR_HEADER_SIZE + shorts.length * 2);
  const view = new DataView(out.buffer);
  writeAscii(out, 2, 16, 'LASF_Projection');
  view.setUint16(18, 34735, true);
  view.setUint16(20, shorts.length * 2, true);
  writeAscii(out, 22, 32, 'GeoKeyDirectoryTag');
  shorts.forEach((value, i) => view.setUint16(VLR_HEADER_SIZE + i * 2, value, true));
  return out;
}

/**
 * Lit `onRecord(view, at)` pour chaque point d'un LAS (brut) ou LAZ
 * (laz-perf, point par point, sans matérialiser tout le fichier décompressé).
 */
function forEachRecord(
  bytes: Uint8Array,
  header: SourceHeader,
  lazPerf: LazPerf,
  onRecord: (view: DataView, at: number) => void,
): void {
  const compressed = (bytes[104]! & 0xc0) !== 0;
  if (!compressed) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.pointDataOffset + header.pointCount * header.pointDataRecordLength > bytes.byteLength) {
      throw new Error('Fichier LAS tronqué');
    }
    for (let i = 0; i < header.pointCount; i++) onRecord(view, header.pointDataOffset + i * header.pointDataRecordLength);
    return;
  }
  const filePointer = lazPerf._malloc(bytes.byteLength);
  const pointPointer = lazPerf._malloc(header.pointDataRecordLength);
  const reader = new lazPerf.LASZip();
  try {
    lazPerf.HEAPU8.set(bytes, filePointer);
    reader.open(filePointer, bytes.byteLength);
    let heap: ArrayBuffer = lazPerf.HEAPU8.buffer;
    let view = new DataView(heap);
    for (let i = 0; i < header.pointCount; i++) {
      reader.getPoint(pointPointer);
      if (lazPerf.HEAPU8.buffer !== heap) {
        heap = lazPerf.HEAPU8.buffer;
        view = new DataView(heap);
      }
      onRecord(view, pointPointer);
    }
  } finally {
    reader.delete();
    lazPerf._free(filePointer);
    lazPerf._free(pointPointer);
  }
}

export async function mergeLasFiles(
  files: ArrayBuffer[],
  options: LasMergeOptions,
  lazPerf: LazPerf,
  onProgress?: (done: number) => void,
): Promise<ArrayBuffer> {
  const { Las } = await import('copc');
  const sources = files.map((buffer) => {
    const bytes = new Uint8Array(buffer);
    const header = Las.Header.parse(bytes) as SourceHeader;
    if (header.pointDataRecordFormat > 5) {
      throw new Error(`Format de point LAS ${header.pointDataRecordFormat} non pris en charge pour la fusion`);
    }
    return { bytes, header };
  });

  const total = sources.reduce((sum, { header }) => sum + header.pointCount, 0);
  if (total === 0) throw new Error('Aucun point à fusionner');
  const count = Math.min(total, options.maxPoints);
  const scale = Math.max(MIN_SCALE, Math.min(...sources.flatMap(({ header }) => header.scale.slice(0, 3))));

  const vlr = geoKeyVlr(options.horizontalEpsg, options.verticalEpsg);
  const pointDataOffset = HEADER_SIZE + vlr.byteLength;
  const out = new ArrayBuffer(pointDataOffset + count * RECORD_LENGTH);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  bytes.set(vlr, HEADER_SIZE);

  let kept = 0;
  let carry = 0;
  let processed = 0;
  const byReturn = [0, 0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const { bytes: source, header } of sources) {
    const [sx, sy, sz] = header.scale as [number, number, number];
    const [ox, oy, oz] = header.offset as [number, number, number];
    forEachRecord(source, header, lazPerf, (src, at) => {
      if (++processed % 1_000_000 === 0) onProgress?.(processed / total);
      // Éclaircissement de Bresenham : exactement `count` points sur `total`.
      carry += count;
      if (carry < total) return;
      carry -= total;
      const x = src.getInt32(at, true) * sx + ox;
      const y = src.getInt32(at + 4, true) * sy + oy;
      const z = src.getInt32(at + 8, true) * sz + oz;
      const dst = pointDataOffset + kept * RECORD_LENGTH;
      view.setInt32(dst, Math.round((x - options.offsetX) / scale), true);
      view.setInt32(dst + 4, Math.round((y - options.offsetY) / scale), true);
      view.setInt32(dst + 8, Math.round(z / scale), true);
      // Intensité, retours, classe, angle, données utilisateur, source : octets 12–19 communs aux formats 0–5.
      for (let i = 12; i < RECORD_LENGTH; i++) view.setUint8(dst + i, src.getUint8(at + i));
      const returnNumber = src.getUint8(at + 14) & 0x07;
      if (returnNumber >= 1 && returnNumber <= 5) byReturn[returnNumber - 1]!++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      kept++;
    });
  }
  if (kept !== count) throw new Error(`Fusion LAS incomplète : ${kept}/${count} points`);

  // En-tête LAS 1.2.
  writeAscii(bytes, 0, 4, 'LASF');
  bytes[24] = 1;
  bytes[25] = 2;
  writeAscii(bytes, 26, 32, options.systemIdentifier);
  writeAscii(bytes, 58, 32, 'RedView');
  const now = new Date();
  const dayOfYear = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  view.setUint16(90, dayOfYear, true);
  view.setUint16(92, now.getUTCFullYear(), true);
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, pointDataOffset, true);
  view.setUint32(100, 1, true);
  view.setUint8(104, 0);
  view.setUint16(105, RECORD_LENGTH, true);
  view.setUint32(107, count, true);
  byReturn.forEach((n, i) => view.setUint32(111 + i * 4, n, true));
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);
  view.setFloat64(155, options.offsetX, true);
  view.setFloat64(163, options.offsetY, true);
  view.setFloat64(171, 0, true);
  view.setFloat64(179, maxX, true);
  view.setFloat64(187, minX, true);
  view.setFloat64(195, maxY, true);
  view.setFloat64(203, minY, true);
  view.setFloat64(211, maxZ, true);
  view.setFloat64(219, minZ, true);
  onProgress?.(1);
  return out;
}
