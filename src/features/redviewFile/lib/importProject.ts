/**
 * Import d'un fichier `.redview` dans le compte de l'utilisateur : nouveau
 * projet (jamais d'écrasement), fichiers .fit renvoyés dans son bucket,
 * miniature, profils de tracé perso ajoutés à son navigateur.
 *
 * Même déroulé que la duplication d'un projet (useProjectBrowserProjects) :
 * création du projet, envoi des .fit rattachés à son id, puis enregistrement
 * final ; un échec après la création supprime le projet et les .fit envoyés.
 */
import {
  getSavedCustomProfiles,
  saveCustomProfileToStorage,
  type SavedCustomProfile,
} from '@/features/itineraryPanel/lib/project/customProfiles';
import type { ItineraryFitUpload, ItineraryProject } from '@/features/itineraryPanel/types';
import { logger } from '@/shared/lib/logger';
import {
  createProject,
  deleteFitUploads,
  deleteProject,
  saveProject,
  uploadProjectItineraryFitFiles,
  uploadProjectThumbnail,
  type ProjectRow,
} from '@/shared/services/projects';

import { REDVIEW_FILE_EXTENSION, type RedviewFitFile } from './format';
import { buildImportedProjectName, nextFreeName } from './naming';
import { readRedviewFile } from './readRedviewFile';

export interface RedviewImportOptions {
  /** Dossier de destination (null = racine). */
  folderId: string | null;
  /** Noms des projets déjà présents dans ce dossier : le projet importé prend un nom libre. */
  siblingNames: readonly string[];
}

export interface RedviewImportResult {
  row: ProjectRow;
  fitFileCount: number;
  /** .fit gardés dans le projet faute d'avoir pu être envoyés dans le bucket. */
  inlinedFitFileCount: number;
  /** .fit du fichier illisibles ou orphelins, non importés. */
  skippedFitFileCount: number;
  routingProfilesAdded: number;
}

function fileBaseName(file: File): string {
  const name = file.name ?? '';
  return name.toLowerCase().endsWith(REDVIEW_FILE_EXTENSION) ? name.slice(0, -REDVIEW_FILE_EXTENSION.length) : name;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function profileSettingsKey(profile: SavedCustomProfile): string {
  return stableStringify({
    basePresetId: profile.basePresetId ?? null,
    roadTypes: profile.roadTypes,
    priorities: profile.priorities,
  });
}

/**
 * Profils à ajouter au navigateur du destinataire, et ids à remplacer dans les
 * itinéraires : un profil identique déjà présent (même id ou mêmes réglages)
 * est réutilisé ; un id déjà pris par un autre profil en reçoit un nouveau.
 */
function planRoutingProfileMerge(imported: readonly SavedCustomProfile[]): {
  toSave: SavedCustomProfile[];
  remap: Map<string, string>;
} {
  const existing = getSavedCustomProfiles();
  const toSave: SavedCustomProfile[] = [];
  const remap = new Map<string, string>();
  const names = new Set(existing.map((profile) => profile.name.trim().toLowerCase()));
  const ids = new Set(existing.map((profile) => profile.id));

  for (const profile of imported) {
    const key = profileSettingsKey(profile);
    const sameId = existing.find((candidate) => candidate.id === profile.id);
    if (sameId && profileSettingsKey(sameId) === key) continue;
    const twin = existing.find((candidate) => profileSettingsKey(candidate) === key);
    if (twin) {
      remap.set(profile.id, twin.id);
      continue;
    }

    let id = profile.id;
    if (ids.has(id)) {
      id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      remap.set(profile.id, id);
    }
    const name = nextFreeName(profile.name.trim(), names);
    ids.add(id);
    names.add(name.toLowerCase());
    toSave.push({ ...profile, id, name });
  }

  return { toSave, remap };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/**
 * Envoie les .fit d'un itinéraire dans le bucket du destinataire, dans
 * l'ordre. Un envoi refusé garde le fichier dans le projet (champ `base64`,
 * relu par l'hydratation) : rien n'est perdu.
 */
async function uploadItineraryFitFiles(
  projectId: string,
  itineraryId: string,
  files: RedviewFitFile[],
): Promise<{ uploads: ItineraryFitUpload[]; inlined: number }> {
  const uploads: ItineraryFitUpload[] = [];
  let inlined = 0;
  for (const fit of [...files].sort((a, b) => a.index - b.index)) {
    const file = new File([fit.data], fit.name, { type: fit.type, lastModified: fit.lastModified });
    const { uploads: sent } = await uploadProjectItineraryFitFiles(projectId, itineraryId, [file]);
    if (sent[0]) {
      uploads.push(sent[0]);
      continue;
    }
    inlined += 1;
    uploads.push({
      name: fit.name,
      type: fit.type,
      lastModified: fit.lastModified,
      size: fit.data.byteLength,
      base64: bytesToBase64(fit.data),
    });
  }
  return { uploads, inlined };
}

export async function importRedviewFile(file: File, options: RedviewImportOptions): Promise<RedviewImportResult> {
  const parsed = await readRedviewFile(file);
  const name = buildImportedProjectName(parsed.project.name || fileBaseName(file), options.siblingNames);
  const { toSave: profilesToSave, remap } = planRoutingProfileMerge(parsed.routingProfiles);

  const project: ItineraryProject = {
    ...parsed.project,
    name,
    itineraries: parsed.project.itineraries.map((itinerary) => ({
      ...itinerary,
      profileId: remap.get(itinerary.profileId) ?? itinerary.profileId,
    })),
  };

  const row = await createProject(name, project, options.folderId);
  let finalProject = project;
  let inlinedFitFileCount = 0;

  if (parsed.fitFiles.length > 0) {
    const sentUploads: ItineraryFitUpload[] = [];
    try {
      const byItinerary = new Map<string, RedviewFitFile[]>();
      for (const fit of parsed.fitFiles) {
        byItinerary.set(fit.itineraryId, [...(byItinerary.get(fit.itineraryId) ?? []), fit]);
      }
      const uploadsByItinerary = new Map<string, ItineraryFitUpload[]>();
      for (const [itineraryId, files] of byItinerary) {
        const { uploads, inlined } = await uploadItineraryFitFiles(row.id, itineraryId, files);
        uploadsByItinerary.set(itineraryId, uploads);
        sentUploads.push(...uploads.filter((upload) => upload.path));
        inlinedFitFileCount += inlined;
      }
      finalProject = {
        ...project,
        itineraries: project.itineraries.map((itinerary) => {
          const uploads = uploadsByItinerary.get(itinerary.id);
          return uploads ? { ...itinerary, fitUploads: uploads } : itinerary;
        }),
      };
      await saveProject(row.id, finalProject);
    } catch (error) {
      // Projet sans ses .fit : on annule tout plutôt que de laisser un import partiel.
      await deleteProject(row.id).catch((cleanupError: unknown) => {
        logger.projects.warn('redview import rollback: project not deleted', row.id, cleanupError);
      });
      await deleteFitUploads(sentUploads);
      throw error;
    }
  }

  if (parsed.thumbnail) {
    const { mime, data } = parsed.thumbnail;
    await uploadProjectThumbnail(row.id, new Blob([data], { type: mime })).catch((error: unknown) => {
      logger.projects.warn('redview import: thumbnail not saved', error);
    });
  }

  for (const profile of profilesToSave) saveCustomProfileToStorage(profile);

  return {
    row: { ...row, name, data: finalProject },
    fitFileCount: parsed.fitFiles.length,
    inlinedFitFileCount,
    skippedFitFileCount: parsed.skippedFitFiles,
    routingProfilesAdded: profilesToSave.length,
  };
}
