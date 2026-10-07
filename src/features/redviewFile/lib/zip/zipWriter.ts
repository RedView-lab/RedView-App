/**
 * Écriture d'une archive ZIP (APPNOTE 6.3, sous-ensemble sans ZIP64) : entrées
 * stockées ou deflate, CRC-32 et tailles dans l'en-tête local (pas de
 * descripteur de données), répertoire central puis fin de répertoire. Les
 * entrées sont écrites dans l'ordre donné : la première peut servir de
 * signature (convention `mimetype` stockée des formats EPUB / OpenDocument).
 */
import { crc32 } from './crc32';
import { deflateRaw, supportsDeflateRaw } from './deflate';
import { ZipError } from './zipError';

export interface ZipEntryInput {
  /** Chemin dans l'archive, séparateur `/`. */
  name: string;
  data: Uint8Array<ArrayBuffer>;
  /** `false` : stockée telle quelle (données déjà compressées, signature `mimetype`). */
  compress?: boolean;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
/** Version 2.0 : deflate, dossiers. */
const VERSION_NEEDED = 20;
/** Fabriqué par : MS-DOS (attributs externes à 0 lisibles partout), version 2.0. */
const VERSION_MADE_BY = 20;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7e) return false;
  }
  return true;
}

interface HeaderFields {
  name: Uint8Array;
  flags: number;
  method: number;
  stamp: { time: number; date: number };
  crc: number;
  compressedSize: number;
  size: number;
  /** Position de l'en-tête local dans l'archive. */
  offset: number;
}

function localHeader(f: HeaderFields): Uint8Array<ArrayBuffer> {
  const local = new Uint8Array(30 + f.name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  lv.setUint16(4, VERSION_NEEDED, true);
  lv.setUint16(6, f.flags, true);
  lv.setUint16(8, f.method, true);
  lv.setUint16(10, f.stamp.time, true);
  lv.setUint16(12, f.stamp.date, true);
  lv.setUint32(14, f.crc, true);
  lv.setUint32(18, f.compressedSize, true);
  lv.setUint32(22, f.size, true);
  lv.setUint16(26, f.name.length, true);
  lv.setUint16(28, 0, true);
  local.set(f.name, 30);
  return local;
}

function centralHeader(f: HeaderFields): Uint8Array<ArrayBuffer> {
  const central = new Uint8Array(46 + f.name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
  cv.setUint16(4, VERSION_MADE_BY, true);
  cv.setUint16(6, VERSION_NEEDED, true);
  cv.setUint16(8, f.flags, true);
  cv.setUint16(10, f.method, true);
  cv.setUint16(12, f.stamp.time, true);
  cv.setUint16(14, f.stamp.date, true);
  cv.setUint32(16, f.crc, true);
  cv.setUint32(20, f.compressedSize, true);
  cv.setUint32(24, f.size, true);
  cv.setUint16(28, f.name.length, true);
  // 30 extra, 32 commentaire, 34 disque, 36 attributs internes, 38 externes : 0.
  cv.setUint32(42, f.offset, true);
  central.set(f.name, 46);
  return central;
}

function endOfCentralDirectory(count: number, centralSize: number, centralOffset: number): Uint8Array<ArrayBuffer> {
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  return end;
}

/**
 * Archive construite entrée par entrée à partir de Blobs, stockés sans
 * recompression (fichiers `.redview` déjà compressés) : une seule entrée est
 * en mémoire à la fois, le temps de son CRC-32 ; l'archive finale ne fait que
 * référencer les Blobs. Sert à l'export de toutes les données d'un compte.
 */
export class StoredZipBuilder {
  private readonly encoder = new TextEncoder();
  private readonly stamp: { time: number; date: number };
  private readonly parts: BlobPart[] = [];
  private readonly centralHeaders: Uint8Array<ArrayBuffer>[] = [];
  private readonly names = new Set<string>();
  private offset = 0;

  constructor(modifiedAt = new Date()) {
    this.stamp = dosDateTime(modifiedAt);
  }

  get size(): number {
    return this.offset;
  }

  async add(entryName: string, data: Blob | Uint8Array<ArrayBuffer>): Promise<void> {
    if (!entryName || entryName.startsWith('/') || this.names.has(entryName)) {
      throw new ZipError('corrupted', `invalid or duplicate entry name "${entryName}"`);
    }
    if (this.centralHeaders.length >= MAX_U16) throw new ZipError('too-large', 'too many entries');
    const name = this.encoder.encode(entryName);
    if (name.length > MAX_U16) throw new ZipError('too-large', `entry name of ${name.length} bytes`);
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    if (bytes.length > MAX_U32 - 1 || this.offset + 30 + name.length + bytes.length > MAX_U32 - 1) {
      throw new ZipError('too-large', 'archive needs ZIP64');
    }
    const fields: HeaderFields = {
      name,
      flags: isAscii(entryName) ? 0 : FLAG_UTF8_NAME,
      method: METHOD_STORE,
      stamp: this.stamp,
      crc: crc32(bytes),
      compressedSize: bytes.length,
      size: bytes.length,
      offset: this.offset,
    };
    const local = localHeader(fields);
    this.names.add(entryName);
    // Le Blob d'origine, pas ses octets : l'archive ne garde pas une copie en mémoire.
    this.parts.push(local, data instanceof Blob ? data : bytes);
    this.centralHeaders.push(centralHeader(fields));
    this.offset += local.length + bytes.length;
  }

  finish(): Blob {
    const centralSize = this.centralHeaders.reduce((sum, header) => sum + header.length, 0);
    if (this.offset + centralSize > MAX_U32 - 1) throw new ZipError('too-large', 'archive needs ZIP64');
    const end = endOfCentralDirectory(this.centralHeaders.length, centralSize, this.offset);
    return new Blob([...this.parts, ...this.centralHeaders, end], { type: 'application/zip' });
  }
}

export async function writeZip(entries: readonly ZipEntryInput[], modifiedAt = new Date()): Promise<Blob> {
  if (entries.length > MAX_U16) throw new ZipError('too-large', `${entries.length} entries`);

  const encoder = new TextEncoder();
  const stamp = dosDateTime(modifiedAt);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const centralHeaders: Uint8Array<ArrayBuffer>[] = [];
  const seenNames = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || seenNames.has(entry.name)) {
      throw new ZipError('corrupted', `invalid or duplicate entry name "${entry.name}"`);
    }
    seenNames.add(entry.name);

    const name = encoder.encode(entry.name);
    if (name.length > MAX_U16) throw new ZipError('too-large', `entry name of ${name.length} bytes`);
    const flags = isAscii(entry.name) ? 0 : FLAG_UTF8_NAME;
    const crc = crc32(entry.data);

    let method = METHOD_STORE;
    let payload = entry.data;
    if (entry.compress !== false && entry.data.length > 0 && supportsDeflateRaw()) {
      const deflated = await deflateRaw(entry.data);
      // Données incompressibles : stockées, la lecture n'a rien à décompresser.
      if (deflated.length < entry.data.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    if (entry.data.length > MAX_U32 - 1 || offset + 30 + name.length + payload.length > MAX_U32 - 1) {
      throw new ZipError('too-large', 'archive needs ZIP64');
    }

    const fields = { name, flags, method, stamp, crc, compressedSize: payload.length, size: entry.data.length, offset };
    const local = localHeader(fields);
    const central = centralHeader(fields);

    parts.push(local, payload);
    centralHeaders.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centralHeaders.reduce((sum, header) => sum + header.length, 0);
  if (offset + centralSize > MAX_U32 - 1) throw new ZipError('too-large', 'archive needs ZIP64');

  const end = endOfCentralDirectory(entries.length, centralSize, offset);

  return new Blob([...parts, ...centralHeaders, end], { type: 'application/zip' });
}
