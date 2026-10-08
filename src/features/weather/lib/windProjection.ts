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
 * Vrai si la surcouche de vent sur le terrain peut s'afficher sans risque dans
 * la projection actuelle de la carte. Mercator est toujours pris en charge. Le
 * globe l'est pour des emprises plus petites que le monde qui ne traversent pas
 * l'antiméridien — mapbox-gl 3.x gère correctement les sources image sur le
 * globe pour de telles emprises, mais des coordonnées extrêmes / qui bouclent
 * déclenchaient un plantage interne de `globeTileBounds` (voir
 * wind-overlay-globe-projection-guard-may14). L'ancien comportement refusait
 * purement le globe, ce qui laissait la surcouche totalement invisible pour
 * tous les utilisateurs (la projection par défaut d'un projet est 'globe').
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
	// Refuse le bouclage de l'antiméridien (east < west ou étendue >= 360) et les
	// étendues proches du monde entier qui déclenchaient le plantage de globeTileBounds.
	if (!Number.isFinite(span) || span <= 0 || span > 180) return false;
	if (bounds.north - bounds.south <= 0) return false;
	if (bounds.west < -180 || bounds.east > 180) return false;
	if (bounds.south < -85 || bounds.north > 85) return false;
	return true;
}
