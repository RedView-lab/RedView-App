import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { resolveSwissDownloadUrls } from '../swiss/stacClient';
import { getSwissTileBounds, swissToWgs84 } from '../swiss/coordConvert';
import { fromWgs84, getTileInfo, isCorsica } from '../coordConvert';
import { downloadFirstArchiveCandidate } from './archiveCandidates';
import { NoCoverageError, throwIfCancelled } from './errors';

// swisstopo swissSURFACE3D (Suisse, LV95) ; hors couverture → repli IGN (downloader.ts).

/**
 * Convertit une tuile du maillage suisse (LV95, coin SW en km) vers la tuile
 * équivalente du maillage Lambert93 (IGN), via le centre de la tuile.
 */
export function swissTileToLamb93TileCoord(coord: TileCoord): TileCoord {
  const bounds = getSwissTileBounds({ eastKm: coord.xKm, northKm: coord.yKm });
  const [lon, lat] = swissToWgs84(bounds.minE + 500, bounds.minN + 500);
  const [x, y] = fromWgs84(lon, lat, 'LAMB93');
  const xKm = Math.floor(x / 1000);
  const yKm = Math.floor(y / 1000);
  const info = getTileInfo('LAMB93');
  const altRef = isCorsica(x, y) ? 'IGN78' : info.altRef;
  return { xKm, yKm, territory: info.territory, projection: 'LAMB93', altRef };
}

export async function downloadSwissTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Recherche STAC swisstopo...') });

  const urls = await resolveSwissDownloadUrls({ eastKm: coord.xKm, northKm: coord.yKm });
  throwIfCancelled(signal);
  if (urls.length === 0) {
    throw new NoCoverageError(translateAppText('Pas de couverture swissSURFACE3D à cet emplacement (E{{x}}, N{{y}}).', { x: coord.xKm, y: coord.yKm }));
  }

  const result = await downloadFirstArchiveCandidate({
    coord,
    urls,
    onProgress,
    signal,
    unzipMessage: translateAppText('Décompression .las.zip...'),
    corruptMessage: translateAppText('Fichier nuage de points suisse corrompu (signature LAS invalide).'),
    logTag: 'Swiss',
  });
  if (result.buffer) return result.buffer;
  const { lastError, allNotFound } = result;

  if (allNotFound) {
    // Toutes les URLs (y compris prédites) ont répondu 404 : swisstopo n'a
    // pas cette tuile → déclenche le fallback IGN côté downloadTile.
    throw new NoCoverageError(
      translateAppText(
        'Pas de couverture swissSURFACE3D à cet emplacement (E{{x}}, N{{y}}) — {{count}} URL(s) testée(s), toutes introuvables (404).',
        { x: coord.xKm, y: coord.yKm, count: urls.length },
      )
    );
  }
  throw new Error(
    translateAppText(
      'Impossible de télécharger la tuile swissSURFACE3D (E{{x}}, N{{y}}) — {{count}} URL(s) testée(s). Dernière erreur : {{error}}',
      { x: coord.xKm, y: coord.yKm, count: urls.length, error: lastError?.message || translateAppText('inconnue') },
    )
  );
}
