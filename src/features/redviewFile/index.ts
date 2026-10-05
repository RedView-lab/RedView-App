/**
 * Fichiers projet `.redview` : export d'un projet complet (tracés,
 * prédictions, POI, feuille de route, réglages, fichiers .fit, miniature,
 * profils de tracé perso) et import dans le compte d'un autre utilisateur.
 * Format : lib/format.ts.
 */
export { REDVIEW_FILE_EXTENSION, REDVIEW_MIME_TYPE, buildRedviewFileName } from './lib/format';
export { RedviewFileError, isRedviewFileError, type RedviewFileErrorKind } from './lib/errors';
export {
  exportProjectAsRedview,
  type RedviewExportResult,
  type RedviewExportSource,
} from './lib/exportProject';
export {
  importRedviewFile,
  type RedviewImportOptions,
  type RedviewImportResult,
} from './lib/importProject';
export { describeRedviewExportError, describeRedviewImportError } from './lib/messages';
