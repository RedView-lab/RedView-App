export type ZipErrorKind =
  /** Pas une archive ZIP (signature absente, fichier trop court). */
  | 'not-zip'
  /** Structure incohérente, données tronquées, CRC ou taille faux. */
  | 'corrupted'
  /** ZIP valide mais hors du sous-ensemble lu ici (ZIP64, chiffrement, multi-volume, méthode inconnue). */
  | 'unsupported'
  /** Entrée ou archive au-delà de la limite demandée (protection contre les bombes de décompression). */
  | 'too-large';

export class ZipError extends Error {
  readonly kind: ZipErrorKind;

  constructor(kind: ZipErrorKind, detail: string, options?: { cause?: unknown }) {
    super(`[zip] ${kind}: ${detail}`, options);
    this.name = 'ZipError';
    this.kind = kind;
  }
}
