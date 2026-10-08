import { encodeGzipPayload, gzipProjectJson } from './compression';
import { gzipPayloadChars, MAX_CLOUD_PROJECT_PAYLOAD_CHARS } from './limits';

/** Charge utile cloud du JSON d'un document de projet, encodée hors du fil principal quand c'est possible. */
export interface EncodedProjectPayload {
  /** `gz:` + base64 du gzip quand il tient dans le document (≤ MAX_CLOUD_PROJECT_PAYLOAD_CHARS). */
  data: string | null;
  /** Le gzip lui-même quand il ne tient pas (il part dans le bucket) ; null avec `data` ou sans CompressionStream. */
  gzip: Uint8Array<ArrayBuffer> | null;
  /** CompressionStream était disponible. */
  compressed: boolean;
}

/** Pur : ce que calcule le worker de charge utile (et le repli dans la page). */
export async function encodeProjectPayload(json: string): Promise<EncodedProjectPayload> {
  const gzip = await gzipProjectJson(json);
  if (!gzip) return { data: null, gzip: null, compressed: false };
  if (gzipPayloadChars(gzip.byteLength) <= MAX_CLOUD_PROJECT_PAYLOAD_CHARS) {
    return { data: encodeGzipPayload(gzip), gzip: null, compressed: true };
  }
  return { data: null, gzip, compressed: true };
}

export type PayloadWorkerRequest = { id: number; json: string };
export type PayloadWorkerResponse =
  | ({ id: number } & EncodedProjectPayload)
  | { id: number; error: string };
