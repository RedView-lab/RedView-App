import {
  formatGpsCoordinateLabel,
  reverseGeocodeSettlement,
} from '../../lib/geocoder';

export async function resolveImportedTimelineLabel(
  lon: number,
  lat: number,
): Promise<string> {
  try {
    const settlement = await reverseGeocodeSettlement(lon, lat, {
      maxDistanceMeters: 1000,
    });
    return settlement?.name?.trim() || formatGpsCoordinateLabel(lon, lat);
  } catch {
    return formatGpsCoordinateLabel(lon, lat);
  }
}