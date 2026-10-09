/**
 * Format de fichier `.redview` : un projet RedView complet, partageable.
 *
 * Conteneur : archive ZIP (lisible par n'importe quel outil après renommage
 * en `.zip`). Comme EPUB / OpenDocument, la première entrée est `mimetype`,
 * stockée sans compression : le type est lisible à l'octet 38 du fichier.
 *
 *   mimetype                   application/vnd.redview.project+zip
 *   manifest.json              RedviewManifest (versions, inventaire)
 *   project.json               ItineraryProject complet (tracés, prédictions,
 *                              POI, feuille de route, réglages carte / panneaux)
 *   fit/<n>.fit                fichiers .fit de l'historique de prédiction
 *                              (stockés dans un bucket hors du projet)
 *   routing-profiles.json      profils de tracé perso référencés (localStorage)
 *   thumbnail.webp|jpg|png     miniature du projet
 *
 * Compatibilité : `formatVersion` est la version de l'écrivain,
 * `minReaderVersion` la plus ancienne version de lecteur capable de lire le
 * fichier sans perte. Ajouter un champ facultatif ne change que
 * `formatVersion` ; un changement qu'un ancien lecteur interpréterait mal
 * relève aussi `minReaderVersion`. Le contenu de `project.json` suit le schéma
 * des projets enregistrés : il passe par la même normalisation au chargement
 * (`normalizeItineraryProject`), un fichier ancien s'ouvre donc comme un
 * ancien projet du cloud.
 */
import type { SavedCustomProfile } from '@/features/itineraryPanel/lib/project/customProfiles';
import type { ItineraryProject } from '@/features/itineraryPanel/types';

export const REDVIEW_FILE_EXTENSION = '.redview';
export const REDVIEW_MIME_TYPE = 'application/vnd.redview.project+zip';
export const REDVIEW_FORMAT_ID = 'redview.project';

/** Version écrite par cette application. */
export const REDVIEW_FORMAT_VERSION = 1;
/** Plus haute `minReaderVersion` que cette application sait lire. */
export const REDVIEW_READER_VERSION = 1;

export const ENTRY_MIMETYPE = 'mimetype';
export const ENTRY_MANIFEST = 'manifest.json';
export const ENTRY_PROJECT = 'project.json';
export const ENTRY_ROUTING_PROFILES = 'routing-profiles.json';
export const FIT_ENTRY_PREFIX = 'fit/';

export type ThumbnailMime = 'image/webp' | 'image/jpeg' | 'image/png';

export const THUMBNAIL_ENTRY_BY_MIME: Record<ThumbnailMime, string> = {
  'image/webp': 'thumbnail.webp',
  'image/jpeg': 'thumbnail.jpg',
  'image/png': 'thumbnail.png',
};

/** Garde-fous de lecture (le fichier vient d'un tiers). */
export const REDVIEW_LIMITS = {
  /** Taille du fichier `.redview`. */
  archiveBytes: 512 * 1024 * 1024,
  /** Jusqu'à 20 .fit par itinéraire (MAX_FIT_FILES) : large marge. */
  entries: 4096,
  manifestBytes: 2 * 1024 * 1024,
  routingProfilesBytes: 2 * 1024 * 1024,
  thumbnailBytes: 4 * 1024 * 1024,
  /** Somme des fichiers .fit décompressés. */
  fitTotalBytes: 512 * 1024 * 1024,
  routingProfiles: 200,
} as const;

/** Fichier .fit embarqué, rattaché à un upload d'itinéraire. */
export interface RedviewFitFileRecord {
  /** Entrée de l'archive (`fit/<n>.fit`). */
  entry: string;
  itineraryId: string;
  /** Position dans `itinerary.fitUploads`. */
  index: number;
  name: string;
  type: string;
  lastModified: number;
  size: number;
}

export interface RedviewManifest {
  format: typeof REDVIEW_FORMAT_ID;
  formatVersion: number;
  minReaderVersion: number;
  createdAt: string;
  generator: {
    app: 'RedView';
    /** Build de l'application (commit), pour le support. */
    build?: string;
  };
  /** Résumé lisible sans ouvrir le projet. */
  project: {
    name: string;
    itineraryCount: number;
  };
  fitFiles: RedviewFitFileRecord[];
  thumbnail: { entry: string; mime: ThumbnailMime } | null;
  routingProfiles: { entry: string; count: number } | null;
}

export interface RedviewFitFile {
  itineraryId: string;
  index: number;
  name: string;
  type: string;
  lastModified: number;
  data: Uint8Array<ArrayBuffer>;
}

/** Contenu d'un fichier `.redview`, indépendant du conteneur. */
export interface RedviewContent {
  /** Projet sans références au stockage de l'expéditeur (`fitUploads[].path` / `base64` retirés). */
  project: ItineraryProject;
  fitFiles: RedviewFitFile[];
  routingProfiles: SavedCustomProfile[];
  thumbnail: { mime: ThumbnailMime; data: Uint8Array<ArrayBuffer> } | null;
}

/** Type d'image d'après ses octets (jamais d'après le nom ou le type annoncé). */
export function sniffThumbnailMime(bytes: Uint8Array): ThumbnailMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Nom de fichier lisible pour le projet (accents et espaces gardés), sans
 * caractère interdit sous Windows / macOS / Linux.
 */
export function buildRedviewFileName(projectName: string): string {
  const withoutControls = Array.from(projectName.normalize('NFC'), (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : char;
  }).join('');
  const spaced = withoutControls
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  // 120 caractères entiers : `slice` sur la chaîne pouvait couper un émoji en deux.
  const cleaned = Array.from(spaced).slice(0, 120).join('').replace(/[.\s]+$/g, '');
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const base = !cleaned ? 'projet' : reserved.test(cleaned) ? `${cleaned}-projet` : cleaned;
  return `${base}${REDVIEW_FILE_EXTENSION}`;
}
