/**
 * Deflate brut (RFC 1951, méthode 8 du ZIP) via les flux natifs du navigateur
 * (et de Node ≥ 21) : `CompressionStream('deflate-raw')`. Sans ce format
 * (navigateurs antérieurs à 2023), l'écriture stocke les entrées sans
 * compression et la lecture enveloppe le flux brut dans un gzip (en-tête fixe
 * + CRC-32 et taille déjà connus par le répertoire central).
 */

let deflateRawSupport: boolean | null = null;

export function supportsDeflateRaw(): boolean {
  if (deflateRawSupport != null) return deflateRawSupport;
  try {
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    deflateRawSupport = true;
  } catch {
    deflateRawSupport = false;
  }
  return deflateRawSupport;
}

export async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Flux décompressé d'une entrée deflate dont on connaît le CRC-32 et la taille. */
export function inflateRawStream(compressed: Blob, crc: number, size: number): ReadableStream<Uint8Array> {
  if (supportsDeflateRaw()) {
    return compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  }
  return wrapRawDeflateInGzip(compressed, crc, size).stream().pipeThrough(new DecompressionStream('gzip'));
}

/** Flux deflate brut présenté comme un membre gzip (RFC 1952), CRC-32 et taille fournis. */
export function wrapRawDeflateInGzip(compressed: Blob, crc: number, size: number): Blob {
  // En-tête minimal : ID1 ID2, CM = deflate, aucun drapeau, OS inconnu.
  const header = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  const trailer = new Uint8Array(8);
  const view = new DataView(trailer.buffer);
  view.setUint32(0, crc, true);
  view.setUint32(4, size >>> 0, true);
  return new Blob([header, compressed, trailer]);
}
