/**
 * Minimal ZIP reader for swissSURFACE3D `.las.zip` archives.
 *
 * Only the bits we need:
 *   - read End-Of-Central-Directory (EOCD)
 *   - locate the first non-directory entry
 *   - decompress (stored or DEFLATE) using the browser's DecompressionStream
 *
 * No external dependency. Designed for ZIPs with a single LAS/LAZ entry but
 * tolerates archives with several files (we pick the first one whose name
 * ends with `.las` or `.laz`).
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LFH = 0x04034b50;

interface CentralEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEocd(view: DataView): number {
  // EOCD is at the end of the file; comment may follow (max 65535 bytes).
  const maxBack = Math.min(view.byteLength, 22 + 0xffff);
  const start = view.byteLength - maxBack;
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new Error('ZIP: EOCD not found');
}

function readEocd(view: DataView, offset: number): {
  cdSize: number;
  cdOffset: number;
  totalEntries: number;
  needsZip64: boolean;
} {
  const totalEntries = view.getUint16(offset + 10, true);
  const cdSize = view.getUint32(offset + 12, true);
  const cdOffset = view.getUint32(offset + 16, true);
  const needsZip64 =
    cdSize === 0xffffffff || cdOffset === 0xffffffff || totalEntries === 0xffff;
  return { cdSize, cdOffset, totalEntries, needsZip64 };
}

function readEocd64(view: DataView, eocdOffset: number): {
  cdSize: number;
  cdOffset: number;
  totalEntries: number;
} {
  // EOCD64 locator sits 20 bytes before EOCD.
  const locOffset = eocdOffset - 20;
  if (locOffset < 0 || view.getUint32(locOffset, true) !== SIG_EOCD64_LOC) {
    throw new Error('ZIP: ZIP64 locator missing');
  }
  // EOCD64 absolute offset (8 bytes, little-endian).
  const eocd64Offset = Number(view.getBigUint64(locOffset + 8, true));
  if (view.getUint32(eocd64Offset, true) !== SIG_EOCD64) {
    throw new Error('ZIP: EOCD64 signature missing');
  }
  const totalEntries = Number(view.getBigUint64(eocd64Offset + 32, true));
  const cdSize = Number(view.getBigUint64(eocd64Offset + 40, true));
  const cdOffset = Number(view.getBigUint64(eocd64Offset + 48, true));
  return { cdSize, cdOffset, totalEntries };
}

function parseExtraZip64(
  view: DataView,
  extraOffset: number,
  extraLen: number,
  needSize: boolean,
  needCompSize: boolean,
  needHeaderOffset: boolean
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let off = extraOffset;
  const end = extraOffset + extraLen;
  while (off + 4 <= end) {
    const headerId = view.getUint16(off, true);
    const dataSize = view.getUint16(off + 2, true);
    off += 4;
    if (headerId === 0x0001) {
      let p = off;
      const out: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
      if (needSize) {
        out.uncompressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (needCompSize) {
        out.compressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (needHeaderOffset) {
        out.localHeaderOffset = Number(view.getBigUint64(p, true));
        p += 8;
      }
      return out;
    }
    off += dataSize;
  }
  return {};
}

function readCentralDirectory(
  view: DataView,
  cdOffset: number,
  cdSize: number,
  totalEntries: number
): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < totalEntries && p + 46 <= end; i++) {
    if (view.getUint32(p, true) !== SIG_CD) {
      throw new Error(`ZIP: invalid central directory entry @${p}`);
    }
    const compressionMethod = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let uncompressedSize = view.getUint32(p + 24, true);
    const fileNameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let localHeaderOffset = view.getUint32(p + 42, true);

    const fileNameBytes = new Uint8Array(view.buffer, view.byteOffset + p + 46, fileNameLen);
    const fileName = decoder.decode(fileNameBytes);

    const needSize = uncompressedSize === 0xffffffff;
    const needCompSize = compressedSize === 0xffffffff;
    const needOffset = localHeaderOffset === 0xffffffff;
    if (needSize || needCompSize || needOffset) {
      const z64 = parseExtraZip64(view, p + 46 + fileNameLen, extraLen, needSize, needCompSize, needOffset);
      if (z64.uncompressedSize !== undefined) uncompressedSize = z64.uncompressedSize;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.localHeaderOffset !== undefined) localHeaderOffset = z64.localHeaderOffset;
    }

    entries.push({ fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });

    p += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // `deflate-raw` decompresses raw DEFLATE streams (no zlib header), which is
  // what ZIP entries with method=8 contain.
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Extract the inner LAS/LAZ payload from a swisstopo `.las.zip` archive.
 *
 * Returns the decompressed bytes ready to be fed to the LAS/LAZ parser.
 * Throws if no LAS/LAZ entry is found or the compression is unsupported.
 */
export async function extractLasFromZip(zipBytes: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new DataView(zipBytes);
  const eocdOffset = findEocd(view);
  let { cdOffset, cdSize, totalEntries, needsZip64 } = readEocd(view, eocdOffset);
  if (needsZip64) {
    const z64 = readEocd64(view, eocdOffset);
    cdOffset = z64.cdOffset;
    cdSize = z64.cdSize;
    totalEntries = z64.totalEntries;
  }

  const entries = readCentralDirectory(view, cdOffset, cdSize, totalEntries);
  const lasEntry =
    entries.find(e => /\.las$/i.test(e.fileName)) ??
    entries.find(e => /\.la[sz]$/i.test(e.fileName));
  if (!lasEntry) {
    throw new Error(`ZIP: no LAS/LAZ entry found (got ${entries.map(e => e.fileName).join(', ') || 'none'})`);
  }

  // Local file header — re-read sizes/extra to find data offset.
  const lfh = lasEntry.localHeaderOffset;
  if (view.getUint32(lfh, true) !== SIG_LFH) {
    throw new Error(`ZIP: invalid local file header @${lfh}`);
  }
  const lfhFileNameLen = view.getUint16(lfh + 26, true);
  const lfhExtraLen = view.getUint16(lfh + 28, true);
  const dataOffset = lfh + 30 + lfhFileNameLen + lfhExtraLen;
  const compressed = new Uint8Array(zipBytes, dataOffset, lasEntry.compressedSize);

  if (lasEntry.compressionMethod === 0) {
    // Stored — copy out so the slice doesn't pin the original buffer.
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    return copy.buffer as ArrayBuffer;
  }
  if (lasEntry.compressionMethod === 8) {
    const inflated = await inflateRaw(compressed);
    return inflated.buffer as ArrayBuffer;
  }
  throw new Error(`ZIP: unsupported compression method ${lasEntry.compressionMethod} for ${lasEntry.fileName}`);
}
