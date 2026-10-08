import { describeRedviewImportError } from '@/features/redviewFile/lib/messages';
import { translateAppText } from '@/shared/i18n';
import type { ProjectSummary } from '@/shared/services/projects';

import { rowToSummary } from './rowToSummary';

export interface ProjectImportResult {
  /** Projets créés, dans l'ordre des fichiers. */
  imported: ProjectSummary[];
  /** Messages d'échec traduits (préfixés du nom de fichier s'il y en a plusieurs). */
  failures: string[];
}

/**
 * Importe des fichiers `.redview` dans `folderId`, chacun comme un nouveau
 * projet, l'un après l'autre (noms libres parmi les voisins, mis à jour au fil
 * des imports). Un fichier illisible n'arrête pas les suivants.
 */
export async function importProjectFiles(
  files: File[],
  { folderId, siblingNames }: { folderId: string | null; siblingNames: string[] },
): Promise<ProjectImportResult> {
  // Lecteur (ZIP, assainissement, envois) chargé à l'usage, hors du chargement initial du gestionnaire de projets.
  const { importRedviewFile } = await import('@/features/redviewFile/lib/importProject');
  const names = [...siblingNames];
  const imported: ProjectSummary[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      const result = await importRedviewFile(file, { folderId, siblingNames: names });
      names.push(result.row.name);
      imported.push(rowToSummary(result.row));
      if (result.skippedFitFileCount > 0) {
        console.warn(`[ProjectBrowser] ${file.name}: ${result.skippedFitFileCount} unreadable FIT file(s) skipped`);
      }
    } catch (error) {
      console.warn('[ProjectBrowser] import failed', file.name, error);
      const message = translateAppText(describeRedviewImportError(error));
      failures.push(files.length > 1 ? `${file.name} : ${message}` : message);
    }
  }
  return { imported, failures };
}
