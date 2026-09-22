import type { ItineraryProject } from '@/features/itineraryPanel/types';

const GZ_PREFIX = 'gz:';

/**
 * Compresse un ItineraryProject en gzip + base64 avec préfixe 'gz:'.
 * Le JSON de points GPS et POIs se compresse typiquement à ~85-90%.
 * Un projet lourd de 5 Mo devient ~400-500 Ko, sous le plafond Appwrite (1 000 000 car.).
 */
export async function compressProjectPayload(project: ItineraryProject): Promise<string> {
  const json = JSON.stringify(project);

  if (typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined') {
    try {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      const compressedBlob = await new Response(stream).blob();
      const buffer = await compressedBlob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let binary = '';
      const len = bytes.byteLength;
      const CHUNK = 8192;
      for (let i = 0; i < len; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
      }
      return `${GZ_PREFIX}${btoa(binary)}`;
    } catch (e) {
      console.warn('[compression] CompressionStream failed, fallback to plain JSON', e);
      return json;
    }
  }

  return json;
}

/**
 * Décompresse un payload de projet.
 * Détecte automatiquement les payloads compressés ('gz:...') ou bruts ('{...').
 */
export async function decompressProjectPayload(payload: string): Promise<ItineraryProject> {
  if (typeof payload === 'string' && payload.startsWith(GZ_PREFIX)) {
    const base64 = payload.slice(GZ_PREFIX.length);
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(stream).text();
        return JSON.parse(text) as ItineraryProject;
      }
    } catch (e) {
      console.error('[compression] DecompressionStream failed', e);
      throw e;
    }
  }

  // Rétro-compatibilité : payload JSON brut non compressé
  return JSON.parse(payload) as ItineraryProject;
}

/** Indique si un payload est déjà compressé. */
export function isCompressedPayload(payload: unknown): boolean {
  return typeof payload === 'string' && payload.startsWith(GZ_PREFIX);
}
