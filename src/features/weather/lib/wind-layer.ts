import type { Map as MapboxMap } from 'mapbox-gl';
import type { WindGridDefinition, WindPoint } from '../types';
import { WindCustomLayer, WIND_LAYER_ID } from './wind';
import type { WindData } from './wind-gl';

type MapWithWindLayer = MapboxMap & {
	__redviewWindLayer?: WindCustomLayer;
};

function getStoredLayer(map: MapboxMap): WindCustomLayer | null {
	return (map as MapWithWindLayer).__redviewWindLayer ?? null;
}

function setStoredLayer(map: MapboxMap, layer: WindCustomLayer | null): void {
	const target = map as MapWithWindLayer;
	if (layer) {
		target.__redviewWindLayer = layer;
		return;
	}
	delete target.__redviewWindLayer;
}

function hasUsableStyle(map: MapboxMap): boolean {
	try {
		return Boolean(map.getStyle());
	} catch {
		return false;
	}
}

function ensureWindLayer(map: MapboxMap): WindCustomLayer | null {
	if (!hasUsableStyle(map)) return null;

	const existingLayer = getStoredLayer(map);
	if (map.getLayer(WIND_LAYER_ID) && existingLayer) {
		return existingLayer;
	}

	const layer = new WindCustomLayer();
	try {
		map.addLayer(layer as never);
		setStoredLayer(map, layer);
		return layer;
	} catch {
		return null;
	}
}

function toWindData(grid: WindGridDefinition, points: WindPoint[]): WindData {
	const image = new Float32Array(grid.rows * grid.cols * 3);
	let uMin = Number.POSITIVE_INFINITY;
	let uMax = Number.NEGATIVE_INFINITY;
	let vMin = Number.POSITIVE_INFINITY;
	let vMax = Number.NEGATIVE_INFINITY;
	let speedMin = Number.POSITIVE_INFINITY;
	let speedMax = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < grid.rows * grid.cols; index += 1) {
		const point = points[index];
		const speed = Number.isFinite(point?.speed) ? point.speed : 0;
		const direction = Number.isFinite(point?.direction) ? point.direction : 0;
		const rad = direction * Math.PI / 180;
		const u = -speed * Math.sin(rad);
		const v = -speed * Math.cos(rad);
		const offset = index * 3;

		image[offset] = u;
		image[offset + 1] = v;
		image[offset + 2] = speed;

		uMin = Math.min(uMin, u);
		uMax = Math.max(uMax, u);
		vMin = Math.min(vMin, v);
		vMax = Math.max(vMax, v);
		speedMin = Math.min(speedMin, speed);
		speedMax = Math.max(speedMax, speed);
	}

	if (!Number.isFinite(uMin)) {
		uMin = 0;
		uMax = 0;
		vMin = 0;
		vMax = 0;
		speedMin = 0;
		speedMax = 0;
	}

	return {
		image,
		width: grid.cols,
		height: grid.rows,
		uMin,
		uMax,
		vMin,
		vMax,
		speedMin,
		speedMax,
	};
}

export function initWindParticles(map: MapboxMap): boolean {
	return ensureWindLayer(map) !== null;
}

export function updateWindParticles(
	map: MapboxMap,
	grid: WindGridDefinition,
	points: WindPoint[],
): boolean {
	const layer = ensureWindLayer(map);
	if (!layer) return false;
	layer.setWind(toWindData(grid, points), grid.bounds);
	return true;
}

export function removeWindParticles(map: MapboxMap): void {
	try {
		if (map.getLayer(WIND_LAYER_ID)) {
			map.removeLayer(WIND_LAYER_ID);
		}
	} catch {
		// Ignore style teardown races.
	}
	setStoredLayer(map, null);
}
