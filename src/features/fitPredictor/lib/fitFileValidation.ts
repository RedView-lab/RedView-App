/**
 * Validation légère d'un fichier .fit côté JS, avant envoi / prédiction.
 *
 * Le moteur WASM refuse tout le lot dès qu'un fichier est illisible
 * (« Error parsing FIT file #6 ») : un seul .fit vide, tronqué ou un GPX
 * renommé en .fit bloquait toute prédiction, y compris après rechargement.
 * On vérifie ici l'en-tête FIT (protocole Garmin) :
 *   - octet 0 : taille de l'en-tête, 12 ou 14 ;
 *   - octets 4-7 : taille des données (uint32 LE), > 0 ;
 *   - octets 8-11 : signature ASCII « .FIT » ;
 *   - longueur du fichier >= en-tête + données + CRC (2 octets).
 * Un fichier qui passe ce contrôle peut encore être refusé par le moteur :
 * le hook retire alors le fichier désigné par l'erreur et relance.
 */

export type FitFileProblem = 'empty' | 'not-fit' | 'truncated' | 'no-data';

const FIT_SIGNATURE = [0x2e, 0x46, 0x49, 0x54]; // ".FIT"
const FIT_CRC_BYTES = 2;
const FIT_MAX_HEADER_BYTES = 14;

/** `head` : au moins les 14 premiers octets (ou tout le fichier s'il est plus court). */
export function validateFitHeader(head: Uint8Array, totalSize: number): FitFileProblem | null {
  if (totalSize === 0 || head.length === 0) return 'empty';
  const headerSize = head[0]!;
  if ((headerSize !== 12 && headerSize !== 14) || totalSize < headerSize || head.length < 12) {
    return 'not-fit';
  }
  for (let i = 0; i < FIT_SIGNATURE.length; i++) {
    if (head[8 + i] !== FIT_SIGNATURE[i]) return 'not-fit';
  }
  const dataSize = (head[4]! | (head[5]! << 8) | (head[6]! << 16) | (head[7]! << 24)) >>> 0;
  if (dataSize === 0) return 'no-data';
  if (totalSize < headerSize + dataSize + FIT_CRC_BYTES) return 'truncated';
  return null;
}

export function validateFitBytes(bytes: Uint8Array): FitFileProblem | null {
  return validateFitHeader(bytes, bytes.length);
}

export async function validateFitFile(file: File): Promise<FitFileProblem | null> {
  if (file.size === 0) return 'empty';
  const head = new Uint8Array(await file.slice(0, FIT_MAX_HEADER_BYTES).arrayBuffer());
  return validateFitHeader(head, file.size);
}

/** Motif (texte source FR) d'un fichier refusé. */
export function describeFitFileProblem(problem: FitFileProblem | 'unreadable'): string {
  switch (problem) {
    case 'empty':
      return 'fichier vide';
    case 'no-data':
      return 'aucune donnée d’activité';
    case 'truncated':
      return 'fichier tronqué';
    case 'unreadable':
      return 'illisible par le moteur';
    default:
      return 'pas un fichier FIT';
  }
}

/** Index (0-based) du fichier fautif dans une erreur du moteur « Error parsing FIT file #N ». */
export function parseFailingFitIndex(message: string): number | null {
  const match = /Error parsing FIT file #(\d+)/.exec(message);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : null;
}
