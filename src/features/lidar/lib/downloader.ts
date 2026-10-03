import type { TileCoord, DownloadProgress } from '../types';
import { translateAppText } from '@/shared/i18n/config';
import { hasTile, loadTile } from './storage';
import { isJgd2011Crs } from './coordConvert';
import { downloadFlandersTile, downloadNetherlandsTile } from './download/benelux';
import { isDownloadCancelledError, NoCoverageError, throwIfCancelled } from './download/errors';
import { downloadIgnTile } from './download/ign';
import { downloadJapanTile } from './download/japan';
import { downloadNzTile } from './download/nz';
import { downloadSwissTile, swissTileToLamb93TileCoord } from './download/swiss';

// Téléchargement d'une dalle LiDAR : cache local d'abord, puis le fournisseur
// de sa projection (download/*). Les clients NZ / Japon embarquent les index
// de fichiers générés par `npm run lidar:index` (~1 Mo chacun) : chargés à la
// demande (import dynamique) pour ne pas alourdir le bundle du Dashboard.

export {
  DownloadCancelledError,
  NoCoverageError,
  isDownloadCancelledError,
} from './download/errors';
export { swissTileToLamb93TileCoord } from './download/swiss';

export async function downloadTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);

  if (await hasTile(coord)) {
    onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'cached', message: translateAppText('Chargement depuis le cache...') });
    const cached = await loadTile(coord);
    if (cached) return cached;
  }

  if (coord.projection === 'CH1903_LV95') {
    try {
      return await downloadSwissTile(coord, onProgress, signal);
    } catch (err: unknown) {
      if (isDownloadCancelledError(err)) throw err;
      // Le bbox suisse couvre largement la Haute-Savoie : une tuile routée
      // vers swisstopo peut en réalité être hors couverture (Chamonix,
      // Annecy...). Si swisstopo confirme l'absence de couverture, on
      // retombe sur IGN LiDAR HD avec la tuile Lambert93 équivalente —
      // re-clée en LAMB93 pour que cache, nommage et viewer restent cohérents.
      if (!(err instanceof NoCoverageError)) throw err;
      const lambCoord = swissTileToLamb93TileCoord(coord);
      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: 0,
        totalBytes: 0,
        phase: 'downloading',
        message: translateAppText('Hors couverture swisstopo, recherche IGN LiDAR HD...'),
      });
      try {
        return await downloadIgnTile(lambCoord, onProgress, signal);
      } catch (ignErr: unknown) {
        if (isDownloadCancelledError(ignErr)) throw ignErr;
        if (ignErr instanceof NoCoverageError) {
          throw new Error(
            translateAppText(
              'Aucune couverture LiDAR à cet emplacement — ni swisstopo swissSURFACE3D, ni IGN LiDAR HD (LV95 {{x}}/{{y}}, LAMB93 {{lambX}}/{{lambY}}).',
              { x: coord.xKm, y: coord.yKm, lambX: lambCoord.xKm, lambY: lambCoord.yKm },
            )
          );
        }
        throw ignErr;
      }
    }
  }

  if (coord.projection === 'NZTM2000') {
    return downloadNzTile(coord, onProgress, signal);
  }

  if (isJgd2011Crs(coord.projection)) {
    return downloadJapanTile(coord, onProgress, signal);
  }

  if (coord.projection === 'RD_NEW') {
    return downloadNetherlandsTile(coord, onProgress, signal);
  }

  if (coord.projection === 'BL72') {
    return downloadFlandersTile(coord, onProgress, signal);
  }

  return downloadIgnTile(coord, onProgress, signal);
}
