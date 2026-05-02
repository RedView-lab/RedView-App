import type { ItineraryFitUpload } from '../../types';

export function deserializeLegacyFitUploads(
  uploads: ItineraryFitUpload[] | null | undefined,
): File[] {
  if (!uploads || uploads.length === 0) return [];
  return uploads
    .filter((upload) => typeof upload.base64 === 'string' && upload.base64.length > 0)
    .map((upload) => {
      const base64 = upload.base64 as string;
      const bytes = base64ToBytes(base64);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return new File([buffer], upload.name, {
        type: upload.type || 'application/octet-stream',
        lastModified: upload.lastModified,
      });
    });
}

export function buildFitUploadsSignature(
  uploads: Pick<ItineraryFitUpload, 'name' | 'lastModified' | 'size' | 'path' | 'base64'>[] | null | undefined,
): string {
  if (!uploads || uploads.length === 0) return '';
  return uploads
    .map((upload) => `${upload.name}:${upload.lastModified}:${upload.size}:${upload.path ?? ''}:${upload.base64 ? 'legacy' : ''}`)
    .join('|');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}