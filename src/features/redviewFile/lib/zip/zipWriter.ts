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

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    // 30 extra, 32 commentaire, 34 disque, 36 attributs internes, 38 externes : 0.
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local, payload);
    centralHeaders.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centralHeaders.reduce((sum, header) => sum + header.length, 0);
  if (offset + centralSize > MAX_U32 - 1) throw new ZipError('too-large', 'archive needs ZIP64');

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...centralHeaders, end], { type: 'application/zip' });
}
