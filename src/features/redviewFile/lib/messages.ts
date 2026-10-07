/**
 * Messages d'erreur affichables (texte source français, à passer par `t()` /
 * `translateAppText`). Les erreurs cloud ont ici un texte propre à l'import :
 * celui de l'enregistrement automatique (« modifications conservées sur cet
 * appareil ») n'a pas de sens pour un projet qui n'a pas été créé.
 */
import { isProjectCloudError, type ProjectCloudErrorKind } from '@/shared/services/projects';

import { isRedviewFileError } from './errors';

const IMPORT_CLOUD_MESSAGES: Record<ProjectCloudErrorKind, string> = {
  offline: 'Connexion au cloud impossible : le projet n’a pas été importé. Réessayez une fois en ligne.',
  'too-large': 'Projet trop volumineux pour la sauvegarde cloud (limite 30 Mo compressés, environ 100 Mo de projet) : il ne peut pas être importé.',
  unauthorized: 'Session expirée : reconnectez-vous puis importez à nouveau le projet.',
  conflict: 'Le serveur a refusé l’import du projet.',
  'not-found': 'Le serveur a refusé l’import du projet.',
  rejected: 'Le serveur a refusé l’import du projet.',
  unreadable: 'Le serveur a refusé l’import du projet.',
};

export function describeRedviewImportError(error: unknown): string {
  if (isRedviewFileError(error)) return error.message;
  if (isProjectCloudError(error)) return IMPORT_CLOUD_MESSAGES[error.kind];
  return 'Impossible d’importer ce projet.';
}

export function describeRedviewExportError(error: unknown): string {
  if (isRedviewFileError(error)) return error.message;
  if (isProjectCloudError(error)) {
    if (error.kind === 'offline') return 'Connexion au cloud impossible : le projet n’a pas pu être exporté. Réessayez une fois en ligne.';
    if (error.kind === 'unauthorized') return 'Session expirée : reconnectez-vous puis exportez à nouveau le projet.';
    if (error.kind === 'unreadable') return 'Les données de ce projet dans le cloud sont illisibles : il ne peut pas être exporté.';
  }
  return 'Impossible d’exporter le projet.';
}
