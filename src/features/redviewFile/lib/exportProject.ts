/**
 * Export d'un projet en fichier `.redview` : rassemble ce que le projet
 * référence hors de son JSON (fichiers .fit du bucket, profils de tracé perso
 * du localStorage, miniature) puis déclenche le téléchargement.
 */
import {
  getSavedCustomProfiles,
  mergeAvailableCustomProfiles,
} from '@/features/itineraryPanel/lib/project/customProfiles';
import { stripLocalWork } from '@/features/itineraryPanel/lib/project/layers';
import { deserializeLegacyFitUploads } from '@/features/itineraryPanel/lib/schedule/persisted-fit-files';
import type { ItineraryFitUpload, ItineraryProject } from '@/features/itineraryPanel/types';
import { APP_BUILD_ID } from '@/shared/lib/appCacheEpoch';
import { logger } from '@/shared/lib/logger';
import { downloadProjectItineraryFitFileEntries, loadProjectThumbnailBlob } from '@/shared/services/projects';

import { withEffectiveControlPanel } from './effectiveControlPanel';
import { RedviewFileError } from './errors';
import {
  buildRedviewFileName,
  REDVIEW_LIMITS,
  sniffThumbnailMime,
  type RedviewContent,
  type RedviewFitFile,
} from './format';
import { writeRedviewFile } from './writeRedviewFile';

export interface RedviewExportSource {
  /** État complet et à jour du projet (y compris la vue carte et les panneaux). */
  project: ItineraryProject;
  /** Projet enregistré : sert à retrouver sa miniature quand `thumbnail` est absent. */
  projectId?: string | null;
  /** Miniature fraîche (capture de la carte). */
  thumbnail?: Blob | null;
}

export interface RedviewExportResult {
  fileName: string;
  sizeBytes: number;
  fitFileCount: number;
  /** Fichiers .fit supprimés du stockage : absents du fichier exporté. */
  missingFitFiles: string[];
}

async function toBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Fichiers .fit de chaque itinéraire, dans l'ordre de `fitUploads`. Un fichier
 * supprimé du bucket (404) est écarté (l'application le retirerait du projet
 * à la prochaine ouverture) ; un téléchargement impossible (réseau) fait
 * échouer l'export plutôt que de produire un fichier incomplet.
 */
async function collectFitFiles(project: ItineraryProject): Promise<{ files: RedviewFitFile[]; missing: string[] }> {
  const files: RedviewFitFile[] = [];
  const missing: string[] = [];

  for (const itinerary of project.itineraries) {
    const uploads = itinerary.fitUploads ?? [];
    if (uploads.length === 0) continue;

    const stored = uploads.filter((upload) => typeof upload.path === 'string' && upload.path.length > 0);
    const downloaded = stored.length > 0 ? await downloadProjectItineraryFitFileEntries(stored) : [];
    const byPath = new Map(downloaded.map((entry) => [entry.path, entry]));

    let index = 0;
    for (const upload of uploads) {
      let file: File | null = null;
      if (upload.path) {
        const entry = byPath.get(upload.path);
        if (entry?.file) {
          file = entry.file;
        } else if (entry?.notFound) {
          missing.push(upload.name);
          continue;
        } else {
          throw new RedviewFileError('fit-unavailable');
        }
      } else if (upload.base64) {
        file = deserializeLegacyFitUploads([upload as ItineraryFitUpload])[0] ?? null;
      }
      if (!file) continue;

      files.push({
        itineraryId: itinerary.id,
        index: index++,
        name: upload.name || file.name,
        type: upload.type || file.type || 'application/octet-stream',
        lastModified: upload.lastModified || file.lastModified,
        data: await toBytes(file),
      });
    }
  }

  return { files, missing };
}

async function collectThumbnail(source: RedviewExportSource): Promise<RedviewContent['thumbnail']> {
  let blob = source.thumbnail ?? null;
  if (!blob && source.projectId) {
    blob = await loadProjectThumbnailBlob(source.projectId).catch(() => null);
  }
  if (!blob || blob.size === 0 || blob.size > REDVIEW_LIMITS.thumbnailBytes) return null;
  const data = await toBytes(blob);
  const mime = sniffThumbnailMime(data);
  return mime ? { mime, data } : null;
}

/**
 * Profils de tracé perso utilisés par les itinéraires : bibliothèque du compte
 * de l'expéditeur, sinon la copie embarquée dans le projet.
 */
function collectRoutingProfiles(project: ItineraryProject): RedviewContent['routingProfiles'] {
  const used = new Set(project.itineraries.map((itinerary) => itinerary.profileId));
  return mergeAvailableCustomProfiles(getSavedCustomProfiles(), project.routingProfiles)
    .filter((profile) => used.has(profile.id));
}

export async function buildRedviewFile(source: RedviewExportSource): Promise<{ blob: Blob; fitFileCount: number; missingFitFiles: string[] }> {
  // Les états du projet sont immuables (ProjectStore, instantané du Dashboard) :
  // pas de copie profonde, coûteuse sur un gros projet. Le travail en attente
  // de cet appareil (routage pas encore appliqué) ne part pas dans le fichier.
  const project = withEffectiveControlPanel(stripLocalWork(source.project));
  const [{ files, missing }, thumbnail] = await Promise.all([
    collectFitFiles(project),
    collectThumbnail(source),
  ]);
  const blob = await writeRedviewFile(
    { project, fitFiles: files, routingProfiles: collectRoutingProfiles(project), thumbnail },
    { build: APP_BUILD_ID },
  );
  if (missing.length > 0) logger.projects.warn('redview export: FIT files missing from storage', missing);
  return { blob, fitFileCount: files.length, missingFitFiles: missing };
}

/**
 * Téléchargement par lien temporaire. L'URL reste valide une minute : la
 * révoquer aussitôt après le clic interrompait parfois l'enregistrement des
 * gros fichiers (Safari, Firefox).
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportProjectAsRedview(source: RedviewExportSource): Promise<RedviewExportResult> {
  const { blob, fitFileCount, missingFitFiles } = await buildRedviewFile(source);
  const fileName = buildRedviewFileName(source.project.name);
  downloadBlob(blob, fileName);
  return { fileName, sizeBytes: blob.size, fitFileCount, missingFitFiles };
}
