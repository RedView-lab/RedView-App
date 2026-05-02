export const GOOGLE_MAPS_TILE_CENTER_ZOOM = 16;

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

export function buildTileLocationLabel(lon: number, lat: number): string {
  return `Lon ${formatCoordinate(lon)} · Lat ${formatCoordinate(lat)}`;
}

export function buildGoogleMapsTileCenterUrl(lon: number, lat: number): string {
  const url = new URL('https://www.google.com/maps/@');
  url.searchParams.set('api', '1');
  url.searchParams.set('map_action', 'map');
  url.searchParams.set('center', `${lat.toFixed(6)},${lon.toFixed(6)}`);
  url.searchParams.set('zoom', String(GOOGLE_MAPS_TILE_CENTER_ZOOM));
  return url.toString();
}