// Couverture swissSURFACE3D (swisstopo, Suisse + Liechtenstein).
//
// Source : collection STAC `ch.swisstopo.swisssurface3d` de data.geo.admin.ch
// (publique, pagination par curseur), un item par dalle de 1 km et par année
// d'acquisition : `swisssurface3d_<année>_<E km>-<N km>`, coin sud-ouest en
// LV95. Seuls les items qui portent un nuage téléchargeable (.las.zip, .laz)
// comptent — c'est le même critère que `swiss/stacClient.ts` au clic.
import fs from 'node:fs';
import path from 'node:path';
import proj4 from 'proj4';
import { CACHE_DIR } from './s3.mjs';
import { squareGridCoverage } from './raster.mjs';
import { roundLonLat } from './encode.mjs';

const ITEMS = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d/items?limit=100';
const LV95 = '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs';
const RE_ITEM = /^swisssurface3d_(\d{4})_(\d{3,4})-(\d{3,4})$/;

async function fetchJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (res.ok) return await res.json();
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`STAC swisstopo : échec ${url}`);
}

/** Ids des items qui ont un nuage de points téléchargeable, en cache. */
async function cachedSwissItems({ refresh = false } = {}) {
  const file = path.join(CACHE_DIR, 'swisssurface3d-items.json');
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = [];
  let url = ITEMS;
  let pages = 0;
  while (url) {
    const page = await fetchJson(url);
    for (const item of page.features ?? []) {
      const assets = Object.keys(item.assets ?? {});
      if (assets.some(k => /\.(las\.zip|laz)$/i.test(k))) ids.push(item.id);
    }
    url = (page.links ?? []).find(l => l.rel === 'next')?.href ?? null;
    if (++pages % 50 === 0) console.log(`  STAC swisstopo : ${pages} pages, ${ids.length} items`);
  }
  ids.sort();
  fs.writeFileSync(file, JSON.stringify(ids));
  return ids;
}

export async function buildSwiss({ refresh = false } = {}) {
  const ids = await cachedSwissItems({ refresh });
  const cells = new Map();
  const years = new Map();
  for (const id of ids) {
    const m = id.match(RE_ITEM);
    if (!m) continue;
    years.set(m[1], (years.get(m[1]) ?? 0) + 1);
    cells.set(`${m[2]}-${m[3]}`, [Number(m[2]), Number(m[3])]);
  }
  const toLonLat = proj4(LV95, 'EPSG:4326').forward;
  const polygons = squareGridCoverage(cells.values(), 1000, toLonLat, roundLonLat);
  return {
    items: ids.length,
    tiles: cells.size,
    stats: [...years.entries()].sort().map(([year, items]) => ({ year: Number(year), items })),
    coverage: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }] },
  };
}
