import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  buildExportFileName,
  triggerBrowserDownload,
} from './exportHelpers';
import { buildItineraryGpx } from './exportGpx';
import { buildItineraryKml } from './exportKml';
import { buildItineraryFitCourse } from './exportFit';

export type ItineraryExportFormat = 'gpx' | 'fit' | 'kml';

export {
  buildItineraryGpx,
  buildItineraryKml,
  buildItineraryFitCourse,
};

/**
 * Exporte et déclenche le téléchargement d'un itinéraire au format GPX, KML ou FIT.
 */
export function exportItineraryFile(
  itinerary: Itinerary,
  format: ItineraryExportFormat,
): { fileName: string } {
  const fileName = buildExportFileName(itinerary, format);

  if (format === 'gpx') {
    const xml = buildItineraryGpx(itinerary);
    triggerBrowserDownload(new Blob([xml], { type: 'application/gpx+xml;charset=utf-8' }), fileName);
    return { fileName };
  }

  if (format === 'kml') {
    const xml = buildItineraryKml(itinerary);
    triggerBrowserDownload(
      new Blob([xml], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' }),
      fileName,
    );
    return { fileName };
  }

  const fitBytes = buildItineraryFitCourse(itinerary);
  const fitPayload = new Uint8Array(fitBytes.byteLength);
  fitPayload.set(fitBytes);
  triggerBrowserDownload(new Blob([fitPayload], { type: 'application/octet-stream' }), fileName);
  return { fileName };
}