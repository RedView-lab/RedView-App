import { encodeGzipPayload, gzipProjectJson } from './compression';
import { gzipPayloadChars, MAX_CLOUD_PROJECT_PAYLOAD_CHARS } from './limits';

/** Cloud payload of a project document JSON, encoded off the main thread where possible. */
export interface EncodedProjectPayload {
  /** `gz:` + base64 of the gzip when it fits in the document (≤ MAX_CLOUD_PROJECT_PAYLOAD_CHARS). */
  data: string | null;
  /** The gzip itself when it does not fit (it goes to the bucket); null with `data` or without CompressionStream. */
  gzip: Uint8Array<ArrayBuffer> | null;
  /** CompressionStream was available. */
  compressed: boolean;
}

/** Pure: what the payload worker computes (and the in-page fallback). */
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
