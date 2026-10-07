import type { ItineraryProject } from './types';

/**
 * Limite client de la taille JSON brute d'un projet (octets UTF-8), bien
 * au-delà des plus gros projets réalistes (plusieurs méga-GPX) : garde-fou
 * mémoire, la vraie limite cloud est celle du fichier compressé ci-dessous.
 */
export const MAX_PROJECT_SIZE_BYTES = 128 * 1024 * 1024;

/**
 * Limite de la charge utile cloud *dans* le document Appwrite (chaîne `gz:` +
 * base64, ou JSON brut en repli) : l'attribut `projects.data` accepte
 * 16 000 000 caractères mais le nginx devant Appwrite répond 502 au-delà
 * d'environ 12 M caractères. Au-delà, la charge utile part dans le bucket
 * `project-payloads` (payloadFiles.ts) et le document ne garde qu'un pointeur.
 */
export const MAX_CLOUD_PROJECT_PAYLOAD_CHARS = 12_000_000;

/**
 * Taille maximale du fichier gzip d'un projet dans le bucket `project-payloads`
 * (`maximumFileSize` du bucket, plafonné par `_APP_STORAGE_LIMIT` = 30 Mo) :
 * ≈ 100 Mo de projet brut. L'upload est découpé en morceaux de 5 Mo par le SDK,
 * sous la limite du nginx. Au-delà : erreur « too-large » (copie locale gardée).
 */
export const MAX_CLOUD_PROJECT_FILE_BYTES = 30_000_000;

/** Longueur de la chaîne `gz:` + base64 produite pour `byteLength` octets gzip. */
export function gzipPayloadChars(byteLength: number): number {
  return 3 + 4 * Math.ceil(byteLength / 3);
}

/**
 * Taille UTF-8 d'une chaîne sans l'encoder (pas d'allocation, contrairement à
 * `new Blob([s]).size` / `TextEncoder`) : utilisée sur le JSON déjà sérialisé.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export function computeProjectSizeBytes(project: ItineraryProject): number {
  try {
    return utf8ByteLength(JSON.stringify(project));
  } catch {
    return 0;
  }
}

export function isProjectTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_PROJECT_SIZE_BYTES;
}

/** La charge utile ne tient pas dans le document : elle part dans le bucket. */
export function isCloudPayloadTooLarge(payload: string): boolean {
  return payload.length > MAX_CLOUD_PROJECT_PAYLOAD_CHARS;
}
