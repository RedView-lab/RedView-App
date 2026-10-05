/**
 * Sérialise un `RedviewContent` en fichier `.redview` (voir format.ts). Pur :
 * aucun accès réseau ni stockage, utilisable sous Node (bancs de test).
 */
import type { ItineraryFitUpload, ItineraryProject } from '@/features/itineraryPanel/types';
import { MAX_PROJECT_SIZE_BYTES } from '@/shared/utils/projects/limits';

import { RedviewFileError } from './errors';
import {
  ENTRY_MANIFEST,
  ENTRY_MIMETYPE,
  ENTRY_PROJECT,
  ENTRY_ROUTING_PROFILES,
  FIT_ENTRY_PREFIX,
  REDVIEW_FORMAT_ID,
  REDVIEW_FORMAT_VERSION,
  REDVIEW_MIME_TYPE,
  REDVIEW_READER_VERSION,
  THUMBNAIL_ENTRY_BY_MIME,
  type RedviewContent,
  type RedviewFitFileRecord,
  type RedviewManifest,
} from './format';
import { writeZip, type ZipEntryInput } from './zip/zipWriter';
import { ZipError } from './zip/zipError';

export interface WriteRedviewOptions {
  /** Build de l'application, inscrit dans le manifeste. */
  build?: string;
  createdAt?: Date;
}

/**
 * `fitUploads` de chaque itinéraire réécrits d'après les fichiers embarqués :
 * métadonnées seules, dans l'ordre des fichiers (le chemin du bucket de
 * l'expéditeur n'a aucun sens pour le destinataire).
 */
function projectForArchive(content: RedviewContent): ItineraryProject {
  const uploadsByItinerary = new Map<string, ItineraryFitUpload[]>();
  const sorted = [...content.fitFiles].sort((a, b) => a.index - b.index);
  for (const file of sorted) {
    const uploads = uploadsByItinerary.get(file.itineraryId) ?? [];
    uploads.push({ name: file.name, type: file.type, lastModified: file.lastModified, size: file.data.byteLength });
    uploadsByItinerary.set(file.itineraryId, uploads);
  }
  return {
    ...content.project,
    itineraries: content.project.itineraries.map((itinerary) => {
      const next = { ...itinerary };
      delete next.fitUploads;
      const uploads = uploadsByItinerary.get(itinerary.id);
      return uploads ? { ...next, fitUploads: uploads } : next;
    }),
  };
}

function encodeJson(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>;
}

export async function writeRedviewFile(content: RedviewContent, options: WriteRedviewOptions = {}): Promise<Blob> {
  const createdAt = options.createdAt ?? new Date();
  const project = projectForArchive(content);
  const projectBytes = encodeJson(project);
  if (projectBytes.byteLength > MAX_PROJECT_SIZE_BYTES) throw new RedviewFileError('too-large');

  const fitEntries: ZipEntryInput[] = [];
  const fitRecords: RedviewFitFileRecord[] = [];
  const itineraryIds = new Set(project.itineraries.map((itinerary) => itinerary.id));
  const perItineraryIndex = new Map<string, number>();
  for (const file of [...content.fitFiles].sort((a, b) => a.index - b.index)) {
    if (!itineraryIds.has(file.itineraryId)) continue;
    // Index compacté : position réelle dans le `fitUploads` écrit ci-dessus.
    const index = perItineraryIndex.get(file.itineraryId) ?? 0;
    perItineraryIndex.set(file.itineraryId, index + 1);
    const entry = `${FIT_ENTRY_PREFIX}${fitRecords.length + 1}.fit`;
    fitEntries.push({ name: entry, data: file.data });
    fitRecords.push({
      entry,
      itineraryId: file.itineraryId,
      index,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      size: file.data.byteLength,
    });
  }

  const thumbnailEntry = content.thumbnail ? THUMBNAIL_ENTRY_BY_MIME[content.thumbnail.mime] : null;
  const manifest: RedviewManifest = {
    format: REDVIEW_FORMAT_ID,
    formatVersion: REDVIEW_FORMAT_VERSION,
    minReaderVersion: REDVIEW_READER_VERSION,
    createdAt: createdAt.toISOString(),
    generator: { app: 'RedView', ...(options.build ? { build: options.build } : {}) },
    project: { name: project.name, itineraryCount: project.itineraries.length },
    fitFiles: fitRecords,
    thumbnail: content.thumbnail && thumbnailEntry ? { entry: thumbnailEntry, mime: content.thumbnail.mime } : null,
    routingProfiles: content.routingProfiles.length > 0
      ? { entry: ENTRY_ROUTING_PROFILES, count: content.routingProfiles.length }
      : null,
  };

  const entries: ZipEntryInput[] = [
    { name: ENTRY_MIMETYPE, data: new TextEncoder().encode(REDVIEW_MIME_TYPE) as Uint8Array<ArrayBuffer>, compress: false },
    { name: ENTRY_MANIFEST, data: encodeJson(manifest) },
    { name: ENTRY_PROJECT, data: projectBytes },
  ];
  if (manifest.routingProfiles) {
    entries.push({ name: ENTRY_ROUTING_PROFILES, data: encodeJson(content.routingProfiles) });
  }
  entries.push(...fitEntries);
  if (content.thumbnail && thumbnailEntry) {
    entries.push({ name: thumbnailEntry, data: content.thumbnail.data, compress: false });
  }

  try {
    const zip = await writeZip(entries, createdAt);
    return new Blob([zip], { type: REDVIEW_MIME_TYPE });
  } catch (error) {
    if (error instanceof ZipError && error.kind === 'too-large') throw new RedviewFileError('too-large', { cause: error });
    throw error;
  }
}
