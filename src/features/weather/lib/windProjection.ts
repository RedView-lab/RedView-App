import type { Map as MapboxMap } from 'mapbox-gl';

export type WindOverlayProjectionName = 'mercator' | 'globe' | 'other';

export function getWindOverlayProjection(map: MapboxMap): WindOverlayProjectionName {
	try {
		const projection = (map as MapboxMap & {
			getProjection?: () => string | { name?: string } | null;
		}).getProjection?.();

		if (!projection) return 'mercator';

		const name = typeof projection === 'string' ? projection : projection.name;
		if (name === 'mercator') return 'mercator';
		if (name === 'globe') return 'globe';
		return 'other';
	} catch {
		return 'other';
	}
}

/**
 * Returns true if the wind terrain overlay can safely render on the current
 * map projection. Mercator is always supported. Globe is supported for
 * sub-world bounds that don't cross the antimeridian — mapbox-gl 3.x handles
 * image sources on globe correctly for such bounds, but extreme/wrapping
 * coords used to trigger an internal `globeTileBounds` crash (see
 * wind-overlay-globe-projection-guard-may14). The legacy behaviour was to
 * reject globe outright, which left the overlay completely invisible to all
 * users (default project projection is 'globe').
 */
export function isWindProjectionSupported(
	map: MapboxMap,
	bounds?: { west: number; east: number; south: number; north: number },
): boolean {
	const projection = getWindOverlayProjection(map);
	if (projection === 'mercator') return true;
	if (projection !== 'globe') return false;
	if (!bounds) return true;

	const span = bounds.east - bounds.west;
	// Reject antimeridian wrap (east<west or span >=360) and near-full-world
	// spans that previously hit the globeTileBounds crash.
	if (!Number.isFinite(span) || span <= 0 || span > 180) return false;
	if (bounds.north - bounds.south <= 0) return false;
	if (bounds.west < -180 || bounds.east > 180) return false;
	if (bounds.south < -85 || bounds.north > 85) return false;
	return true;
}
