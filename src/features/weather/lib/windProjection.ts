import type { Map as MapboxMap } from 'mapbox-gl';

export function isWindProjectionSupported(map: MapboxMap): boolean {
	try {
		const projection = (map as MapboxMap & {
			getProjection?: () => string | { name?: string } | null;
		}).getProjection?.();

		if (!projection) return true;

		const name = typeof projection === 'string' ? projection : projection.name;
		return name === 'mercator';
	} catch {
		return false;
	}
}
