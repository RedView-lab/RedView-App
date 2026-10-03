import { translateAppText } from '@/shared/i18n/config';

// Erreurs du téléchargement des dalles LiDAR (annulation, absence de couverture).

export type DownloadFailure = Error & {
  status?: number;
  code?: string;
};

/** Erreur levée lorsqu'un téléchargement est annulé par l'utilisateur. */
export class DownloadCancelledError extends Error {
  constructor() {
    super(translateAppText('Téléchargement annulé'));
    this.name = 'DownloadCancelledError';
    (this as unknown as { code?: string }).code = 'ERR_DOWNLOAD_CANCELLED';
  }
}

/**
 * Erreur levée lorsqu'un fournisseur confirme n'avoir aucune couverture pour
 * la tuile demandée (recherche vide ou toutes URLs introuvables 404) —
 * c'est le signal déclencheur du fallback inter-fournisseurs.
 */
export class NoCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCoverageError';
    (this as unknown as { code?: string }).code = 'ERR_NO_COVERAGE';
  }
}

export function isDownloadCancelledError(err: unknown): boolean {
  return (
    err instanceof DownloadCancelledError ||
    (err as { code?: string } | null | undefined)?.code === 'ERR_DOWNLOAD_CANCELLED'
  );
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadCancelledError();
}

export function invalidLasSignatureError(buffer: ArrayBuffer): DownloadFailure {
  const bytes = new Uint8Array(buffer.slice(0, Math.min(4, buffer.byteLength)));
  const preview = Array.from(bytes)
    .map((value) => String.fromCharCode(value >= 32 && value <= 126 ? value : 0xFFFD))
    .join('');
  const err = new Error(translateAppText('Signature LAS/COPC invalide : {{preview}}', { preview: preview || translateAppText('vide') })) as DownloadFailure;
  err.code = 'ERR_INVALID_LAS_SIGNATURE';
  return err;
}
