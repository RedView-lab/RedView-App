/**
 * Erreurs des fichiers `.redview`. Les messages sont du texte source français,
 * traduit à l'affichage par `t()` / `translateAppText` (paires dans
 * shared/i18n/config/translations/projectBrowser.ts).
 */

export type RedviewFileErrorKind =
  /** Ce n'est pas un fichier `.redview` (autre format, autre archive ZIP). */
  | 'not-redview'
  /** Fichier tronqué ou altéré (structure, CRC, JSON illisible). */
  | 'corrupted'
  /** Créé par une version plus récente de RedView. */
  | 'newer-version'
  /** Au-delà des limites de taille acceptées. */
  | 'too-large'
  /** Contenu lisible mais qui n'est pas un projet valide. */
  | 'invalid-project'
  /** Navigateur sans les flux de (dé)compression nécessaires. */
  | 'unsupported-browser'
  /** Fichiers .fit du projet introuvables ou injoignables au moment de l'export. */
  | 'fit-unavailable';

export const REDVIEW_FILE_ERROR_MESSAGES: Record<RedviewFileErrorKind, string> = {
  'not-redview': 'Ce fichier n’est pas un projet RedView (.redview).',
  corrupted: 'Le fichier .redview est endommagé ou incomplet. Demandez à l’expéditeur de l’exporter à nouveau.',
  'newer-version': 'Ce projet a été exporté par une version plus récente de RedView. Rechargez la page pour mettre l’application à jour, puis réessayez.',
  'too-large': 'Ce fichier .redview dépasse la taille maximale acceptée.',
  'invalid-project': 'Le fichier .redview ne contient pas de projet valide.',
  'unsupported-browser': 'Votre navigateur ne permet pas de lire ou d’écrire des fichiers .redview. Mettez-le à jour.',
  'fit-unavailable': 'Impossible de récupérer les fichiers .fit du projet : vérifiez votre connexion puis réessayez.',
};

export class RedviewFileError extends Error {
  readonly kind: RedviewFileErrorKind;

  constructor(kind: RedviewFileErrorKind, options?: { cause?: unknown }) {
    super(REDVIEW_FILE_ERROR_MESSAGES[kind], options);
    this.name = 'RedviewFileError';
    this.kind = kind;
  }
}

export function isRedviewFileError(error: unknown): error is RedviewFileError {
  return error instanceof RedviewFileError;
}
