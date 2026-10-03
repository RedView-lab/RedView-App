import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { parseJgd2011Zone } from '../coordConvert';
import { downloadFirstArchiveCandidate, footprintBounds } from './archiveCandidates';
import { throwIfCancelled } from './errors';

// Japon (JGD2011 / S3 Open Data / VIRTUAL SHIZUOKA / Tokyo 3D Point Clouds).
// Le client STAC embarque l'index des fichiers (~1 Mo) : import dynamique.

export async function downloadJapanTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);
  const zone = parseJgd2011Zone(coord.projection);
  onProgress?.({
    tileCoord: coord,
    bytesDownloaded: 0,
    totalBytes: 0,
    phase: 'downloading',
    message: translateAppText('Recherche nuage de points LiDAR Japon (zone {{zone}})...', { zone }),
  });

  const { resolveJapanDownloadUrls } = await import('../japan/stacClient');
  throwIfCancelled(signal);
  const urls = await resolveJapanDownloadUrls({
    eastKm: coord.xKm,
    northKm: coord.yKm,
    zone,
  }, footprintBounds(coord));
  throwIfCancelled(signal);

  if (urls.length === 0) {
    throw new Error(
      translateAppText(
        "Pas de nuage de points LiDAR classifié disponible pour la dalle ({{x}}, {{y}}) en zone JGD2011 {{zone}}. Cette zone n'a pas encore fait l'objet d'un relevé ouvert.",
        { x: coord.xKm, y: coord.yKm, zone },
      )
    );
  }

  const result = await downloadFirstArchiveCandidate({
    coord,
    urls,
    onProgress,
    signal,
    unzipMessage: translateAppText('Décompression archive point cloud LAS Japon...'),
    corruptMessage: translateAppText('Fichier nuage de points japonais corrompu (signature LAS invalide).'),
    logTag: 'Japan',
  });
  if (result.buffer) return result.buffer;
  const { lastError } = result;

  throw new Error(
    translateAppText(
      'Impossible de télécharger le nuage de points LiDAR Japon ({{x}}, {{y}}, zone {{zone}}) — {{count}} URL(s) testée(s). Dernière erreur : {{error}}',
      { x: coord.xKm, y: coord.yKm, zone, count: urls.length, error: lastError?.message || translateAppText('inconnue') },
    )
  );
}
