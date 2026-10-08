import { translateAppText } from '@/shared/i18n';
import { ensureHealthDataConsent } from '@/shared/services/healthDataConsent';
import {
  createProject,
  deleteProject,
  deleteFitUploads,
  deleteProjectThumbnail,
  duplicateProjectItineraryFitFiles,
  duplicateProjectThumbnail,
  getProject,
  saveProject,
  type ItineraryFitUpload,
  type ProjectRow,
} from '@/shared/services/projects';

import { buildCopiedName } from './naming';

export interface DuplicatedProject {
  row: ProjectRow;
  name: string;
  thumbnailCopied: boolean;
}

/**
 * Copie complète d'un projet : document, fichiers FIT de chaque itinéraire et
 * miniature, dans le dossier de l'original, sous un nom libre parmi ses
 * voisins (`siblingNamesOf`). Tout ou rien : à la moindre erreur, la copie
 * partielle (ligne, FIT, miniature) est supprimée avant de relancer l'erreur.
 */
export async function duplicateProjectWithAssets(
  projectId: string,
  siblingNamesOf: (folderId: string | null) => string[],
): Promise<DuplicatedProject> {
  let duplicateProjectId: string | null = null;
  let duplicateFitUploads: Record<string, ItineraryFitUpload[]> = {};
  try {
    const source = await getProject(projectId);
    if (!source) throw new Error(translateAppText('Projet introuvable.'));

    const name = buildCopiedName(source.name, siblingNamesOf(source.folder_id));
    const duplicateData = structuredClone(source.data);
    duplicateData.name = name;
    duplicateData.privacy = source.privacy;
    duplicateData.savedAt = null;
    duplicateData.sizeBytes = null;

    // Créée sans les fichiers FIT de l'original : la copie reçoit les siens
    // plus bas. Avec ceux de l'original, un retour arrière (deleteProject de la
    // copie, qui efface les fichiers référencés) effacerait ceux de l'original.
    const row = await createProject(
      name,
      { ...duplicateData, itineraries: duplicateData.itineraries.map((itinerary) => ({ ...itinerary, fitUploads: [] })) },
      source.folder_id,
    );
    duplicateProjectId = row.id;

    // Données de santé (RGPD art. 9) : sans accord, la copie n'a pas de .fit.
    const carriesFit = duplicateData.itineraries.some((itinerary) => (itinerary.fitUploads ?? []).length > 0);
    const copyFit = carriesFit && await ensureHealthDataConsent();
    if (copyFit) {
      duplicateFitUploads = await duplicateProjectItineraryFitFiles(
        duplicateData.itineraries.map((itinerary) => ({ id: itinerary.id, fitUploads: itinerary.fitUploads })),
        row.id,
      );
    }
    await saveProject(row.id, {
      ...duplicateData,
      itineraries: duplicateData.itineraries.map((itinerary) => ({
        ...itinerary,
        fitUploads: copyFit ? duplicateFitUploads[itinerary.id] ?? itinerary.fitUploads : [],
      })),
    });
    const thumbnailCopied = await duplicateProjectThumbnail(projectId, row.id);
    return { row, name, thumbnailCopied };
  } catch (error) {
    if (duplicateProjectId) {
      try {
        await deleteProject(duplicateProjectId);
      } catch {
        // Rollback au mieux ; le nettoyage du stockage suit quand même.
      }
      // Les copies FIT déjà envoyées, même si la copie n'a pas pu les référencer.
      await Promise.allSettled([
        deleteFitUploads(Object.values(duplicateFitUploads).flat()),
        deleteProjectThumbnail(duplicateProjectId),
      ]);
    }
    throw error;
  }
}
