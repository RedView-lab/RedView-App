import type { PoiCategory, PoiFeature, OverpassResponse } from '../types';

// ── Overpass endpoints (fallback chain) ───────────────────────────────

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// ── OSM tag → PoiCategory mapping ─────────────────────────────────────

interface TagMapping {
  key: string;
  value: string;
  category: PoiCategory;
}

const TAG_MAPPINGS: TagMapping[] = [
  { key: 'amenity', value: 'drinking_water', category: 'drinking_water' },
  { key: 'shop', value: 'bakery', category: 'bakery' },
  { key: 'shop', value: 'convenience', category: 'convenience' },
  { key: 'shop', value: 'supermarket', category: 'supermarket' },
  { key: 'shop', value: 'bicycle', category: 'bicycle' },
  { key: 'amenity', value: 'bicycle_repair_station', category: 'bicycle_repair' },
  { key: 'amenity', value: 'toilets', category: 'toilets' },
  { key: 'amenity', value: 'shelter', category: 'shelter' },
  { key: 'tourism', value: 'camp_site', category: 'camp_site' },
  { key: 'amenity', value: 'pharmacy', category: 'pharmacy' },
  { key: 'amenity', value: 'hospital', category: 'hospital' },
];

// ── Build Overpass QL query ───────────────────────────────────────────

function buildQuery(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
): string {
  const enabledMappings = TAG_MAPPINGS.filter((m) => categories.includes(m.category));
  if (enabledMappings.length === 0) return '';

  const bbox = `(${south},${west},${north},${east})`;
  const nodeQueries = enabledMappings
    .map((m) => `  node[${m.key}=${m.value}]${bbox};`)
    .join('\n');

  // Also fetch ways for camp_site (often mapped as areas)
  const wayQueries = enabledMappings
    .filter((m) => m.category === 'camp_site' || m.category === 'hospital')
    .map((m) => `  way[${m.key}=${m.value}]${bbox};`)
    .join('\n');

  return `[out:json][timeout:30];
(
${nodeQueries}
${wayQueries}
);
out center body qt;`;
}

// ── Parse response into PoiFeature[] ──────────────────────────────────

function classifyElement(tags: Record<string, string>): PoiCategory | null {
  for (const m of TAG_MAPPINGS) {
    if (tags[m.key] === m.value) return m.category;
  }
  return null;
}

function parseResponse(data: OverpassResponse): PoiFeature[] {
  const results: PoiFeature[] = [];

  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const tags = el.tags ?? {};
    const category = classifyElement(tags);
    if (!category) continue;

    results.push({
      id: el.id,
      lat,
      lon,
      category,
      name: tags.name ?? null,
      tags,
    });
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────

export async function fetchPoisInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  categories: PoiCategory[],
  signal?: AbortSignal,
): Promise<PoiFeature[]> {
  const query = buildQuery(south, west, north, east, categories);
  if (!query) return [];

  let lastError: Error | null = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Overpass ${res.status}`);
        continue; // try fallback
      }

      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

      const json: OverpassResponse = await res.json();
      return parseResponse(json);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      continue; // try fallback
    }
  }

  throw lastError ?? new Error('All Overpass endpoints failed');
}
