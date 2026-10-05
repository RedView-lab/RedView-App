/**
 * Lecture d'une archive ZIP (sous-ensemble écrit par zipWriter : stockée ou
 * deflate, sans ZIP64 ni chiffrement) depuis un `Blob`, entrée par entrée
 * (`blob.slice`) : le fichier n'est jamais chargé en entier.
 *
 * Le fichier vient d'un tiers : toute taille annoncée est bornée par
 * l'appelant (`maxBytes`), la décompression s'arrête dès qu'elle dépasse la
 * taille annoncée, et chaque entrée est vérifiée (taille + CRC-32).
 */
import { crc32 } from './crc32';
import { inflateRawStream } from './deflate';
import { ZipError } from './zipError';

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  blob: Blob;
  entries: ReadonlyMap<string, ZipEntry>;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_MARKER_U16 = 0xffff;
const ZIP64_MARKER_U32 = 0xffffffff;

async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Vrai si le fichier commence par un en-tête local ZIP (`PK\x03\x04`). */
export async function hasZipSignature(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const head = await readBytes(blob, 0, 4);
  return new DataView(head.buffer).getUint32(0, true) === LOCAL_HEADER_SIGNATURE;
}

export async function openZip(blob: Blob, options: { maxEntries: number }): Promise<ZipDirectory> {
  if (blob.size < END_OF_CENTRAL_DIRECTORY_SIZE) throw new ZipError('not-zip', 'file too short');

  const tailStart = Math.max(0, blob.size - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_LENGTH);
  const tail = await readBytes(blob, tailStart, blob.size);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - END_OF_CENTRAL_DIRECTORY_SIZE; i >= 0; i--) {
    if (
      tv.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && i + END_OF_CENTRAL_DIRECTORY_SIZE + tv.getUint16(i + 20, true) <= tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not-zip', 'end of central directory not found');

  const disk = tv.getUint16(eocd + 4, true);
  const centralDisk = tv.getUint16(eocd + 6, true);
  const entriesOnDisk = tv.getUint16(eocd + 8, true);
  const entryCount = tv.getUint16(eocd + 10, true);
  const centralSize = tv.getUint32(eocd + 12, true);
  const centralOffset = tv.getUint32(eocd + 16, true);
  const eocdOffset = tailStart + eocd;

  if (entryCount === ZIP64_MARKER_U16 || centralSize === ZIP64_MARKER_U32 || centralOffset === ZIP64_MARKER_U32) {
    throw new ZipError('unsupported', 'ZIP64 archive');
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipError('unsupported', 'multi-volume archive');
  }
  if (entryCount > options.maxEntries) throw new ZipError('too-large', `${entryCount} entries`);
  if (centralOffset + centralSize > eocdOffset) throw new ZipError('corrupted', 'central directory out of bounds');

  const central = await readBytes(blob, centralOffset, centralOffset + centralSize);
  const cv = new DataView(central.buffer);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, ZipEntry>();
  let p = 0;

  for (let index = 0; index < entryCount; index++) {
    if (p + 46 > central.length || cv.getUint32(p, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipError('corrupted', `bad central header #${index}`);
    }
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    const compressedSize = cv.getUint32(p + 20, true);
    const size = cv.getUint32(p + 24, true);
    const nameLength = cv.getUint16(p + 28, true);
    const extraLength = cv.getUint16(p + 30, true);
    const commentLength = cv.getUint16(p + 32, true);
    const localHeaderOffset = cv.getUint32(p + 42, true);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > central.length) throw new ZipError('corrupted', `central header #${index} out of bounds`);

    if (flags & FLAG_ENCRYPTED) throw new ZipError('unsupported', 'encrypted entry');
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError('unsupported', `compression method ${method}`);
    }
    if (compressedSize === ZIP64_MARKER_U32 || size === ZIP64_MARKER_U32 || localHeaderOffset === ZIP64_MARKER_U32) {
      throw new ZipError('unsupported', 'ZIP64 entry');
    }
    if (localHeaderOffset + 30 + compressedSize > centralOffset) {
      throw new ZipError('corrupted', `entry #${index} data out of bounds`);
    }

    const name = decoder.decode(central.subarray(p + 46, p + 46 + nameLength));
    if (entries.has(name)) throw new ZipError('corrupted', `duplicate entry "${name}"`);
    entries.set(name, { name, method, crc32: crc, compressedSize, size, localHeaderOffset });
    p = next;
  }

  return { blob, entries };
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let written = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new ZipError('corrupted', 'invalid deflate data', { cause: error });
      }
      if (chunk.done) break;
      // Plus de données que la taille annoncée : bombe ou archive corrompue.
      if (written + chunk.value.length > expectedSize) {
        throw new ZipError('corrupted', 'entry larger than declared');
      }
      out.set(chunk.value, written);
      written += chunk.value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (written !== expectedSize) throw new ZipError('corrupted', 'entry shorter than declared');
  return out;
}

/** Contenu vérifié (taille + CRC-32) d'une entrée, au plus `maxBytes` octets. */
export async function readZipEntry(
  directory: ZipDirectory,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (entry.size > maxBytes) throw new ZipError('too-large', `entry "${entry.name}" is ${entry.size} bytes`);

  const { blob } = directory;
  const local = await readBytes(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  const lv = new DataView(local.buffer);
  if (local.length < 30 || lv.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipError('corrupted', `bad local header for "${entry.name}"`);
  }
  // Longueurs du nom et du champ extra de l'en-tête LOCAL (peuvent différer du répertoire central).
  const dataStart = entry.localHeaderOffset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > blob.size) throw new ZipError('corrupted', `entry "${entry.name}" truncated`);

  let data: Uint8Array<ArrayBuffer>;
  if (entry.method === METHOD_STORE) {
    if (entry.compressedSize !== entry.size) throw new ZipError('corrupted', `stored entry "${entry.name}" size mismatch`);
    data = await readBytes(blob, dataStart, dataEnd);
  } else {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = inflateRawStream(blob.slice(dataStart, dataEnd), entry.crc32, entry.size);
    } catch (error) {
      throw new ZipError('unsupported', 'no deflate support', { cause: error });
    }
    data = await collectStream(stream, entry.size);
  }

  if (crc32(data) !== entry.crc32) throw new ZipError('corrupted', `CRC mismatch for "${entry.name}"`);
  return data;
}
