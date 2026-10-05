import { translateAppText } from '@/shared/i18n';
import {
  createProject,
  deleteProject,
  deleteProjectFitFiles,
  deleteProjectThumbnail,
  duplicateProjectItineraryFitFiles,
  duplicateProjectThumbnail,
  getProject,
  saveProject,
  type ProjectRow,
} from '@/shared/utils/projects';

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
  try {
    const source = await getProject(projectId);
    if (!source) throw new Error(translateAppText('Projet introuvable.'));

    const name = buildCopiedName(source.name, siblingNamesOf(source.folder_id));
    const duplicateData = structuredClone(source.data);
    duplicateData.name = name;
    duplicateData.privacy = source.privacy;
    duplicateData.savedAt = null;
    duplicateData.sizeBytes = null;

    const row = await createProject(name, duplicateData, source.folder_id);
    duplicateProjectId = row.id;

    const duplicateFitUploads = await duplicateProjectItineraryFitFiles(
      duplicateData.itineraries.map((itinerary) => ({ id: itinerary.id, fitUploads: itinerary.fitUploads })),
      row.id,
    );
    await saveProject(row.id, {
      ...duplicateData,
      itineraries: duplicateData.itineraries.map((itinerary) => ({
        ...itinerary,
        fitUploads: duplicateFitUploads[itinerary.id] ?? itinerary.fitUploads,
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
      await Promise.allSettled([deleteProjectFitFiles(duplicateProjectId), deleteProjectThumbnail(duplicateProjectId)]);
    }
    throw error;
  }
}
