import { translateAppText } from '@/shared/i18n/config';
import { StorageFullError } from '../storage';

// Erreurs du téléchargement des dalles LiDAR (annulation, absence de couverture).

export type DownloadFailure = Error & {
  /** Statut HTTP de la réponse refusée. */
  status?: number;
  code?: string;
  /** Octets déjà reçus d'un flux interrompu (`ERR_INCOMPLETE_DOWNLOAD`), pour la reprise. */
  resumeState?: unknown;
};

/** Erreur HTTP d'un téléchargement : le statut décide de la suite (404 = URL suivante). */
export function httpStatusError(message: string, status: number): DownloadFailure {
  const err: DownloadFailure = new Error(message);
  err.status = status;
  return err;
}

/** Une valeur levée vue comme DownloadFailure (statut, code et reprise absents s'ils n'y sont pas). */
export function asDownloadFailure(err: unknown): DownloadFailure {
  return err instanceof Error ? err : new Error(String(err));
}

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

/**
 * Ends a download at once, without trying the next URL of the tile: a
 * cancellation, or a full storage (each candidate would be fetched again,
 * hundreds of MB, to fail the same way).
 */
export function isFinalDownloadError(err: unknown): boolean {
  return isDownloadCancelledError(err) || err instanceof StorageFullError;
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
