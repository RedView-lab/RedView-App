/**
 * Format des messages sur la WebSocket : JSON en trame texte ; un message
 * d'au moins `WIRE_COMPRESS_MIN_CHARS` caractères (état complet, rattrapage,
 * lot qui porte des segments de tracé) peut partir en trame binaire = JSON
 * UTF-8 compressé en DEFLATE brut (RFC 1951, `deflate-raw`).
 *
 * Négocié, jamais imposé : le client annonce `hello.compress` s'il sait
 * décompresser, le serveur ne compresse que pour lui et annonce
 * `welcome.compress` (le client compresse alors ses gros envois). Un ancien
 * client, ou un client sans `CompressionStream`, reste en texte.
 *
 * Pourquoi pas `permessage-deflate` : Chromium y compresse chaque message
 * (lots, caméra et curseur à 30 Hz…), le serveur décompressait donc chaque
 * message entrant et compressait chaque gros message une fois par
 * destinataire, dans la file zlib du processus — la salle saturait à 50
 * salles (`bench:collab-load`). Ici un gros message n'est compressé qu'une
 * fois pour toute la salle et les petits ne passent jamais par zlib.
 */

/** Seuil de compression (caractères JSON) : en dessous, le gain ne vaut pas l'aller-retour asynchrone. */
export const WIRE_COMPRESS_MIN_CHARS = 16 * 1024;

/** Taille maximale d'un message décompressé (comme une trame texte : `maxPayload` du serveur). */
export const WIRE_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Le navigateur sait décompresser (`hello.compress`). */
export function canInflateWire(): boolean {
  return typeof DecompressionStream === 'function';
}

/** Le navigateur sait compresser (envois après `welcome.compress`). */
export function canDeflateWire(): boolean {
  return typeof CompressionStream === 'function';
}

async function pipe(bytes: BufferSource | string, transform: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer();
}

/** JSON → trame binaire (client : envoi d'un gros message). */
export async function deflateWire(json: string): Promise<ArrayBuffer> {
  return pipe(json, new CompressionStream('deflate-raw'));
}

/** Trame binaire → JSON (client : message du serveur). */
export async function inflateWire(data: ArrayBuffer | Blob): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')));
}
