/**
 * Lit et valide un fichier `.redview` (voir format.ts). Pur : aucun accès
 * réseau ni stockage, utilisable sous Node (bancs de test).
 *
 * Le fichier vient d'un tiers : tailles bornées entrée par entrée, CRC
 * vérifiés, JSON validé (sanitizeProject.ts), images et .fit reconnus à leurs
 * octets. Toute erreur sort en `RedviewFileError`.
 */
import { MAX_FIT_FILE_BYTES, validateFitHeader } from '@/features/fitPredictor/lib/fitFileValidation';
import { MAX_PROJECT_SIZE_BYTES } from '@/shared/utils/projects/limits';

import { RedviewFileError } from './errors';
import {
  ENTRY_MANIFEST,
  ENTRY_MIMETYPE,
  ENTRY_PROJECT,
  FIT_ENTRY_PREFIX,
  REDVIEW_FORMAT_ID,
  REDVIEW_LIMITS,
  REDVIEW_MIME_TYPE,
  REDVIEW_READER_VERSION,
  sniffThumbnailMime,
  type RedviewContent,
  type RedviewFitFile,
  type RedviewManifest,
} from './format';
import { parseUntrustedJson, sanitizeImportedProject, sanitizeRoutingProfiles } from './sanitizeProject';
import { ZipError } from './zip/zipError';
import { hasZipSignature, openZip, readZipEntry, type ZipDirectory } from './zip/zipReader';

export interface ReadRedviewResult extends RedviewContent {
  manifest: RedviewManifest;
  /** Fichiers .fit annoncés mais écartés (illisibles, rattachés à un itinéraire absent). */
  skippedFitFiles: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRedviewError(error: unknown): RedviewFileError {
  if (error instanceof RedviewFileError) return error;
  if (error instanceof ZipError) {
    switch (error.kind) {
      case 'unsupported':
        // ZIP64, chiffrement, multi-volume : jamais écrits par RedView.
        return new RedviewFileError('not-redview', { cause: error });
      case 'not-zip':
        // La signature ZIP a été vue au début du fichier : il est tronqué.
        return new RedviewFileError('corrupted', { cause: error });
      case 'too-large':
        return new RedviewFileError('too-large', { cause: error });
      default:
        return new RedviewFileError('corrupted', { cause: error });
    }
  }
  return new RedviewFileError('corrupted', { cause: error });
}

async function readEntry(directory: ZipDirectory, name: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const entry = directory.entries.get(name);
  return entry ? readZipEntry(directory, entry, maxBytes) : null;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readJsonEntry(directory: ZipDirectory, name: string, maxBytes: number): Promise<unknown> {
  const bytes = await readEntry(directory, name, maxBytes);
  if (!bytes) return undefined;
  return parseUntrustedJson(decodeUtf8(bytes));
}

function parseManifest(raw: unknown): RedviewManifest {
  if (!isRecord(raw) || raw.format !== REDVIEW_FORMAT_ID) throw new RedviewFileError('not-redview');
  const { formatVersion, minReaderVersion } = raw;
  if (!Number.isInteger(formatVersion) || !Number.isInteger(minReaderVersion)) {
    throw new RedviewFileError('corrupted', { cause: new Error('manifest versions') });
  }
  if ((minReaderVersion as number) > REDVIEW_READER_VERSION) throw new RedviewFileError('newer-version');
  return raw as unknown as RedviewManifest;
}

async function readFitFiles(
  directory: ZipDirectory,
  manifest: RedviewManifest,
  itineraryIds: ReadonlySet<string>,
): Promise<{ files: RedviewFitFile[]; skipped: number }> {
  const records: unknown[] = Array.isArray(manifest.fitFiles) ? manifest.fitFiles : [];
  const files: RedviewFitFile[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let totalBytes = 0;

  for (const record of records) {
    const valid = isRecord(record)
      && typeof record.entry === 'string'
      && record.entry.startsWith(FIT_ENTRY_PREFIX)
      && typeof record.itineraryId === 'string'
      && itineraryIds.has(record.itineraryId)
      && Number.isInteger(record.index)
      && (record.index as number) >= 0
      && directory.entries.has(record.entry);
    const key = valid ? `${record.itineraryId}\u0000${record.index as number}` : '';
    if (!valid || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const data = await readEntry(directory, record.entry as string, MAX_FIT_FILE_BYTES);
    if (!data) {
      skipped += 1;
      continue;
    }
    totalBytes += data.byteLength;
    if (totalBytes > REDVIEW_LIMITS.fitTotalBytes) throw new RedviewFileError('too-large');
    // Jamais de contenu arbitraire envoyé dans le bucket des .fit du destinataire.
    if (validateFitHeader(data.subarray(0, 14), data.byteLength) != null) {
      skipped += 1;
      continue;
    }

    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 255) : `activity-${files.length + 1}.fit`;
    files.push({
      itineraryId: record.itineraryId as string,
      index: record.index as number,
      name,
      type: typeof record.type === 'string' && record.type.length <= 100 ? record.type : 'application/octet-stream',
      lastModified: typeof record.lastModified === 'number' && Number.isFinite(record.lastModified) ? record.lastModified : Date.now(),
      data,
    });
  }

  return { files, skipped };
}

async function readThumbnail(directory: ZipDirectory, manifest: RedviewManifest): Promise<RedviewContent['thumbnail']> {
  const entry = isRecord(manifest.thumbnail) && typeof manifest.thumbnail.entry === 'string' ? manifest.thumbnail.entry : null;
  if (!entry) return null;
  const data = await readEntry(directory, entry, REDVIEW_LIMITS.thumbnailBytes);
  const mime = data ? sniffThumbnailMime(data) : null;
  return data && mime ? { mime, data } : null;
}

export async function readRedviewFile(file: Blob): Promise<ReadRedviewResult> {
  if (file.size > REDVIEW_LIMITS.archiveBytes) throw new RedviewFileError('too-large');
  if (typeof DecompressionStream === 'undefined') throw new RedviewFileError('unsupported-browser');

  try {
    if (!(await hasZipSignature(file))) throw new RedviewFileError('not-redview');
    const directory = await openZip(file, { maxEntries: REDVIEW_LIMITS.entries });

    const mimetype = await readEntry(directory, ENTRY_MIMETYPE, 256);
    if (!mimetype || decodeUtf8(mimetype).trim() !== REDVIEW_MIME_TYPE) throw new RedviewFileError('not-redview');

    const manifest = parseManifest(await readJsonEntry(directory, ENTRY_MANIFEST, REDVIEW_LIMITS.manifestBytes));

    const rawProject = await readJsonEntry(directory, ENTRY_PROJECT, MAX_PROJECT_SIZE_BYTES);
    if (rawProject === undefined) throw new RedviewFileError('corrupted', { cause: new Error('project.json missing') });
    const project = sanitizeImportedProject(rawProject);

    const itineraryIds = new Set(project.itineraries.map((itinerary) => itinerary.id));
    const { files: fitFiles, skipped: skippedFitFiles } = await readFitFiles(directory, manifest, itineraryIds);

    const profilesEntry = isRecord(manifest.routingProfiles) && typeof manifest.routingProfiles.entry === 'string'
      ? manifest.routingProfiles.entry
      : null;
    const routingProfiles = profilesEntry
      ? sanitizeRoutingProfiles(await readJsonEntry(directory, profilesEntry, REDVIEW_LIMITS.routingProfilesBytes))
      : [];

    const thumbnail = await readThumbnail(directory, manifest);

    return { manifest, project, fitFiles, skippedFitFiles, routingProfiles, thumbnail };
  } catch (error) {
    throw toRedviewError(error);
  }
}
