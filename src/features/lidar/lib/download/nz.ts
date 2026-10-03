import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { downloadFirstArchiveCandidate, footprintBounds } from './archiveCandidates';
import { throwIfCancelled } from './errors';

// Nouvelle-Zélande (OpenTopography / LINZ Raw LiDAR Point Clouds, NZTM2000).
// Le client STAC embarque l'index des fichiers (~1 Mo) : import dynamique.

export async function downloadNzTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Recherche nuage de points LiDAR Nouvelle-Zélande...') });

  const { resolveNzDownloadUrls } = await import('../nz/stacClient');
  throwIfCancelled(signal);
  const urls = await resolveNzDownloadUrls({ eastKm: coord.xKm, northKm: coord.yKm }, footprintBounds(coord));
  throwIfCancelled(signal);
  if (urls.length === 0) {
    throw new Error(translateAppText("Pas de nuage de points LiDAR classifié disponible pour la dalle ({{x}}, {{y}}). Cette zone n'a pas encore fait l'objet d'un survol LiDAR.", { x: coord.xKm, y: coord.yKm }));
  }

  const result = await downloadFirstArchiveCandidate({
    coord,
    urls,
    onProgress,
    signal,
    unzipMessage: translateAppText('Décompression archive point cloud .laz...'),
    corruptMessage: translateAppText('Fichier nuage de points néo-zélandais corrompu (signature LAS invalide).'),
    logTag: 'NZ',
  });
  if (result.buffer) return result.buffer;
  const { lastError } = result;

  throw new Error(
    translateAppText(
      'Impossible de télécharger le nuage de points LiDAR Nouvelle-Zélande ({{x}}, {{y}}) — {{count}} URL(s) testée(s). Dernière erreur : {{error}}',
      { x: coord.xKm, y: coord.yKm, count: urls.length, error: lastError?.message || translateAppText('inconnue') },
    )
  );
}
