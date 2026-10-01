/**
 * Erreurs typées de la persistance cloud des projets (Appwrite).
 *
 * Toute écriture cloud qui échoue lève une `ProjectCloudError` : l'appelant
 * (autosave, bouton Enregistrer, navigateur de projets) décide de réessayer,
 * d'afficher un toast ou de bloquer. Les messages sont du texte source
 * français traduit par `translateAppText` / `t()` (paires dans
 * shared/i18n/config/translations/projectBrowser.ts).
 */

export type ProjectCloudErrorKind =
  /** Réseau indisponible, timeout, 5xx, 429 : réessayable. */
  | 'offline'
  /** Charge utile au-delà de la limite cloud (compressée > 12 M car.) ou refus de taille. */
  | 'too-large'
  /** Session absente / expirée, ou permission refusée. */
  | 'unauthorized'
  /** Le projet a été modifié ailleurs depuis la version chargée par cette session. */
  | 'conflict'
  /** Le document n'existe plus côté cloud (supprimé). */
  | 'not-found'
  /** Autre refus du serveur (validation, 4xx). */
  | 'rejected';

export const PROJECT_CLOUD_ERROR_MESSAGES: Record<ProjectCloudErrorKind, string> = {
  offline: 'Connexion au cloud impossible : les modifications sont conservées sur cet appareil et seront synchronisées automatiquement.',
  'too-large': 'Projet trop volumineux pour la sauvegarde cloud (limite 12 Mo compressés). Les modifications sont conservées sur cet appareil : allégez le projet ou exportez-le.',
  unauthorized: 'Session expirée : reconnectez-vous pour synchroniser vos projets.',
  conflict: 'Ce projet a été modifié sur un autre appareil.',
  'not-found': 'Ce projet a été supprimé.',
  rejected: 'Le serveur a refusé l’enregistrement du projet.',
};

export class ProjectCloudError extends Error {
  readonly kind: ProjectCloudErrorKind;
  /** Code HTTP Appwrite (0 si erreur réseau). */
  readonly status: number;
  readonly originalError: unknown;

  constructor(kind: ProjectCloudErrorKind, options: { message?: string; status?: number; cause?: unknown } = {}) {
    super(options.message ?? PROJECT_CLOUD_ERROR_MESSAGES[kind]);
    this.name = 'ProjectCloudError';
    this.kind = kind;
    this.status = options.status ?? 0;
    this.originalError = options.cause;
  }

  /** Une nouvelle tentative automatique a des chances d'aboutir. */
  get retryable(): boolean {
    return this.kind === 'offline';
  }
}

export function isProjectCloudError(error: unknown): error is ProjectCloudError {
  return error instanceof ProjectCloudError;
}

function readErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function readErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const { message, type } = error as { message?: unknown; type?: unknown };
  return `${typeof type === 'string' ? type : ''} ${typeof message === 'string' ? message : ''}`;
}

/** Erreur Appwrite 401 (session absente / expirée ou permission refusée). */
export function isUnauthorizedError(error: unknown): boolean {
  return readErrorCode(error) === 401;
}

/**
 * Classe une erreur brute (SDK Appwrite, fetch, timeout) dans une
 * `ProjectCloudError`. Une `ProjectCloudError` est renvoyée telle quelle.
 */
export function toProjectCloudError(error: unknown): ProjectCloudError {
  if (isProjectCloudError(error)) return error;

  const code = readErrorCode(error);
  // fetch() rejeté (TypeError « Failed to fetch »), timeout local, erreur sans code HTTP.
  if (code == null || code === 0) {
    return new ProjectCloudError('offline', { cause: error });
  }
  if (code === 408 || code === 429 || code >= 500) {
    return new ProjectCloudError('offline', { status: code, cause: error });
  }
  if (code === 413) {
    return new ProjectCloudError('too-large', { status: code, cause: error });
  }
  if (code === 401 || code === 403) {
    return new ProjectCloudError('unauthorized', { status: code, cause: error });
  }
  if (code === 404) {
    return new ProjectCloudError('not-found', { status: code, cause: error });
  }
  if (code === 400 && /no longer than|too large|size/i.test(readErrorText(error))) {
    return new ProjectCloudError('too-large', { status: code, cause: error });
  }
  return new ProjectCloudError('rejected', { status: code, cause: error });
}
