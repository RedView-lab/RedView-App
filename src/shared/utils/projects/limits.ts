import type { ItineraryProject } from './types';

/** Limite client de la taille JSON brute d'un projet (octets UTF-8). */
export const MAX_PROJECT_SIZE_BYTES = 16 * 1024 * 1024;

/**
 * Limite de la charge utile cloud envoyée à Appwrite (chaîne `gz:` + base64,
 * ou JSON brut en repli) : l'attribut `projects.data` accepte 16 000 000
 * caractères mais le nginx devant Appwrite répond 502 au-delà d'environ
 * 12 M caractères. Au-delà, la sauvegarde cloud est refusée côté client avec
 * une erreur « too-large » visible (la copie locale est conservée).
 */
export const MAX_CLOUD_PROJECT_PAYLOAD_CHARS = 12_000_000;

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

export function isCloudPayloadTooLarge(payload: string): boolean {
  return payload.length > MAX_CLOUD_PROJECT_PAYLOAD_CHARS;
}
