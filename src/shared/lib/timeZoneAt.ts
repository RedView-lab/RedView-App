/**
 * IANA time zone of a map position, resolved offline from simplified time-zone
 * polygons (@photostructure/tz-lookup, CC0). The ~70 kB table is loaded on
 * first use so it stays out of the entry bundles.
 *
 * Solar features express date and time on the wall clock of the place shown,
 * not of the machine running the browser: a sunrise in London must not be
 * read in Paris time because the viewer happens to be in Paris.
 */

type TzLookup = (latitude: number, longitude: number) => string;

let lookupPromise: Promise<TzLookup | null> | null = null;

function loadLookup(): Promise<TzLookup | null> {
  lookupPromise ??= import('@photostructure/tz-lookup')
    .then((mod) => mod.default)
    .catch((error: unknown) => {
      console.warn('[timeZoneAt] time-zone table unavailable', error);
      lookupPromise = null; // retry on the next call
      return null;
    });
  return lookupPromise;
}

/** Wraps a longitude into [-180, 180] (Mapbox returns world copies beyond it). */
function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * IANA zone at (lng, lat), e.g. "Europe/London" — "Etc/GMT±N" at sea.
 * Resolves to null when the coordinates are invalid or the table failed to
 * load; callers keep their own fallback.
 */
export async function resolveTimeZoneAt(lng: number, lat: number): Promise<string | null> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  const lookup = await loadLookup();
  if (!lookup) return null;
  try {
    return lookup(lat, wrapLongitude(lng));
  } catch {
    return null;
  }
}
