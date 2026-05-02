import type { PredictionResult } from '@/features/fitPredictor';
import {
  downloadProjectItineraryFitFiles,
} from '@/shared/utils/projects';

import {
  buildFitUploadsSignature,
  deserializeLegacyFitUploads,
} from '../../lib/schedule';
import type { ItineraryProject } from '../../types';

export interface HydratedFitRuntimeData {
  fitFiles: File[];
  fitFileNames: string[];
  predictionResult: PredictionResult | null;
  persistedUploadSignature: string;
}

export async function hydratePersistedFitRuntime(
  itinerary: ItineraryProject['itineraries'][number],
): Promise<HydratedFitRuntimeData> {
  const persistedUploads = itinerary.fitUploads ?? [];
  const persistedUploadSignature = buildFitUploadsSignature(persistedUploads);

  const legacyFiles = deserializeLegacyFitUploads(
    persistedUploads.filter((upload) => !upload.path && upload.base64),
  );
  const storageUploads = persistedUploads.filter(
    (upload) => typeof upload.path === 'string' && upload.path.length > 0,
  );
  const downloadedFiles = storageUploads.length > 0
    ? await downloadProjectItineraryFitFiles(storageUploads)
    : [];

  const downloadedByPath = new Map<string, File>();
  for (let index = 0; index < storageUploads.length; index += 1) {
    const path = storageUploads[index]?.path;
    const file = downloadedFiles[index];
    if (path && file) downloadedByPath.set(path, file);
  }

  const legacyQueue = legacyFiles.slice();
  const fitFiles = persistedUploads.flatMap((upload) => {
    if (upload.path) {
      const file = downloadedByPath.get(upload.path);
      return file ? [file] : [];
    }
    const legacy = legacyQueue.shift();
    return legacy ? [legacy] : [];
  });

  return {
    fitFiles,
    fitFileNames: fitFiles.map((file) => file.name),
    predictionResult: itinerary.prediction ?? null,
    persistedUploadSignature,
  };
}