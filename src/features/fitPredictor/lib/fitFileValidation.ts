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
 * On lit aussi le type du fichier (message file_id) : un « course » (parcours
 * exporté d'un planificateur) est refusé ici, dès la sélection, plutôt que
 * d'apparaître dans la liste puis d'être retiré après refus du moteur.
 * Un fichier qui passe ce contrôle peut encore être refusé par le moteur :
 * le hook retire alors le fichier désigné par l'erreur et relance.
 */

export type FitFileProblem =
  | 'empty'
  | 'not-fit'
  | 'truncated'
  | 'no-data'
  | 'too-large'
  | 'planned-course';

/** Taille max du bucket Appwrite des FIT (scripts/setup-appwrite-schema.mjs : 30 000 000 octets). */
export const MAX_FIT_FILE_BYTES = 30_000_000;

const FIT_SIGNATURE = [0x2e, 0x46, 0x49, 0x54]; // ".FIT"
const FIT_CRC_BYTES = 2;

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
  return validateFitHeader(bytes, bytes.length) ?? validateFitFileType(bytes);
}

export async function validateFitFile(file: File): Promise<FitFileProblem | null> {
  if (file.size === 0) return 'empty';
  // Refusé par le bucket de toute façon : on le signale dès la sélection.
  if (file.size > MAX_FIT_FILE_BYTES) return 'too-large';
  const head = new Uint8Array(await file.slice(0, FIT_FILE_ID_SCAN_BYTES).arrayBuffer());
  return validateFitHeader(head, file.size) ?? validateFitFileType(head);
}

/** `file` enum FIT (profil Garmin) d'un parcours planifié. */
export const FIT_FILE_TYPE_COURSE = 6;
/** Le message file_id ouvre le fichier : quelques Ko suffisent, on borne la lecture. */
const FIT_FILE_ID_SCAN_BYTES = 64 * 1024;
const FIT_FILE_ID_SCAN_MAX_RECORDS = 64;
const FIT_MSG_FILE_ID = 0;
const FIT_FILE_ID_TYPE_FIELD = 0;

function validateFitFileType(bytes: Uint8Array): FitFileProblem | null {
  return readFitFileType(bytes) === FIT_FILE_TYPE_COURSE ? 'planned-course' : null;
}

/**
 * Type du fichier FIT (champ `type` du message file_id), lu sans décoder le
 * reste. Même lecture que `decode_file_type` du moteur
 * (vendor/redviewalgo/src/fit_parser.rs). `null` si le message n'est pas
 * trouvé dans la zone lue ou si la structure est inattendue : le moteur garde
 * alors le dernier mot.
 */
export function readFitFileType(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const headerSize = bytes[0]!;
  if (headerSize !== 12 && headerSize !== 14) return null;
  const dataSize = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0;
  const end = Math.min(bytes.length, headerSize + dataSize);

  // Définitions par type local (4 bits) : message global, taille des données,
  // position du champ `type` (enum 1 octet) si présent.
  const definitions: Array<{ globalMessage: number; size: number; typeOffset: number | null } | undefined> = [];
  let pos = headerSize;
  for (let record = 0; record < FIT_FILE_ID_SCAN_MAX_RECORDS && pos < end; record += 1) {
    const header = bytes[pos]!;
    pos += 1;

    const isCompressedTimestamp = (header & 0x80) !== 0;
    if (!isCompressedTimestamp && (header & 0x40) !== 0) {
      // Message de définition : réservé, architecture, n° global (2), nb de champs.
      if (pos + 5 > end) return null;
      const bigEndian = bytes[pos + 1] === 1;
      const globalMessage = bigEndian
        ? (bytes[pos + 2]! << 8) | bytes[pos + 3]!
        : bytes[pos + 2]! | (bytes[pos + 3]! << 8);
      const fieldCount = bytes[pos + 4]!;
      pos += 5;
      if (pos + fieldCount * 3 > end) return null;
      let size = 0;
      let typeOffset: number | null = null;
      for (let field = 0; field < fieldCount; field += 1) {
        const fieldNumber = bytes[pos]!;
        const fieldSize = bytes[pos + 1]!;
        if (fieldNumber === FIT_FILE_ID_TYPE_FIELD && fieldSize === 1 && typeOffset === null) typeOffset = size;
        size += fieldSize;
        pos += 3;
      }
      if ((header & 0x20) !== 0) {
        // Champs développeur : comptés dans la taille des messages de données.
        if (pos >= end) return null;
        const developerFieldCount = bytes[pos]!;
        pos += 1;
        if (pos + developerFieldCount * 3 > end) return null;
        for (let field = 0; field < developerFieldCount; field += 1) {
          size += bytes[pos + 1]!;
          pos += 3;
        }
      }
      definitions[header & 0x0f] = { globalMessage, size, typeOffset };
      continue;
    }

    // Message de données (normal ou à horodatage compressé).
    const localType = isCompressedTimestamp ? (header >> 5) & 0x03 : header & 0x0f;
    const definition = definitions[localType];
    if (!definition || pos + definition.size > end) return null;
    if (definition.globalMessage === FIT_MSG_FILE_ID) {
      return definition.typeOffset === null ? null : bytes[pos + definition.typeOffset]!;
    }
    pos += definition.size;
  }
  return null;
}

/** Refus prononcé par le moteur WASM (après un en-tête valide). */
export type FitEngineRejection = 'unreadable' | 'planned-course';

/**
 * Motif d'un refus du moteur. Un FIT de type « course » (parcours exporté d'un
 * planificateur, vitesse synthétique) est lisible mais n'est pas une sortie :
 * il fausserait le profil (FTP virtuelle aberrante).
 */
export function engineRejectionReason(message: string): FitEngineRejection {
  return /Not an activity/.test(message) ? 'planned-course' : 'unreadable';
}

/** Motif (texte source FR) d'un fichier refusé. */
export function describeFitFileProblem(problem: FitFileProblem | FitEngineRejection): string {
  switch (problem) {
    case 'planned-course':
      return 'parcours planifié, pas une sortie enregistrée';
    case 'empty':
      return 'fichier vide';
    case 'no-data':
      return 'aucune donnée d’activité';
    case 'truncated':
      return 'fichier tronqué';
    case 'unreadable':
      return 'illisible par le moteur';
    case 'too-large':
      return 'trop volumineux, 30 Mo maximum';
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
