// Couverture LiDAR HD IGN (France métropolitaine, Corse, La Réunion).
//
// Source : couche WFS `IGNF_LIDAR-HD_METADONNEE:metadata` de la Géoplateforme,
// une entité par dalle de 1 km publiée, avec le lien du nuage classé
// (`url_npl`, COPC). Le nom du fichier donne la dalle : `LHD_FXX_0098_6847_…`
// = coin nord-ouest en km (X ouest, Y nord), Lambert-93 ; `LHD_REU_…` en
// RGR92 / UTM 40S. Les autres DROM (Guadeloupe, Martinique, Guyane, Mayotte)
// ne sont pas sélectionnables dans l'app (`wgs84ToTileCoord`) : ignorés.
//
// Le téléchargement résout encore l'URL au clic (`wfsClient.ts`, flux ATOM
// par zone) ; la couverture ne sert qu'à l'overlay vert.
import fs from 'node:fs';
import path from 'node:path';
import proj4 from 'proj4';
import { CACHE_DIR } from './s3.mjs';
import { squareGridCoverage } from './raster.mjs';
import { roundLonLat } from './encode.mjs';

const WFS = 'https://data.geopf.fr/wfs/ows';
const LAYER = 'IGNF_LIDAR-HD_METADONNEE:metadata';
/** Plafond de la Géoplateforme par requête GetFeature. */
const PAGE_SIZE = 5000;

const PROJ = {
  LAMB93: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs',
  RGR92UTM40S: '+proj=utm +zone=40 +south +ellps=GRS80 +units=m +no_defs',
};

const RE_TILE = /\/(LHD_([A-Z]+)_(\d{4})_(\d{4})_PTS_([A-Z0-9]+)_[A-Z0-9]+)\.(?:copc\.)?laz$/;

async function fetchPage(startIndex) {
  const params = new URLSearchParams({
    SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: LAYER,
    OUTPUTFORMAT: 'application/json', PROPERTYNAME: 'url_npl',
    // Tri explicite : pagination stable même si la couche est mise à jour pendant le crawl.
    SORTBY: 'url_npl', COUNT: String(PAGE_SIZE), STARTINDEX: String(startIndex),
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${WFS}?${params}`, { signal: AbortSignal.timeout(180_000) });
      if (res.ok) return await res.json();
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(`WFS LiDAR HD : échec de la page ${startIndex}`);
}

/** Noms des dalles publiées (`LHD_FXX_0098_6847_PTS_LAMB93_IGN69`…), en cache. */
async function cachedIgnTiles({ refresh = false } = {}) {
  const file = path.join(CACHE_DIR, 'ign-lidarhd-tiles.json');
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const first = await fetchPage(0);
  const total = first.numberMatched;
  const starts = [];
  for (let s = PAGE_SIZE; s < total; s += PAGE_SIZE) starts.push(s);
  const pages = [first];
  let cursor = 0;
  const worker = async () => {
    while (cursor < starts.length) {
      const start = starts[cursor++];
      pages.push(await fetchPage(start));
      if (pages.length % 10 === 0) console.log(`  WFS LiDAR HD : ${pages.length}/${starts.length + 1} pages`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const returned = pages.reduce((n, p) => n + p.features.length, 0);
  if (returned !== total) throw new Error(`WFS LiDAR HD : ${returned} entités reçues pour ${total} annoncées`);
  const names = new Set();
  for (const page of pages) {
    for (const f of page.features) {
      const m = String(f.properties?.url_npl ?? '').match(RE_TILE);
      if (m) names.add(m[1]);
    }
  }
  const list = [...names].sort();
  fs.writeFileSync(file, JSON.stringify(list));
  return list;
}

export async function buildFrance({ refresh = false } = {}) {
  const names = await cachedIgnTiles({ refresh });
  const cells = { LAMB93: [], RGR92UTM40S: [] };
  const counts = new Map();
  for (const name of names) {
    const m = name.match(/^LHD_([A-Z]+)_(\d{4})_(\d{4})_PTS_([A-Z0-9]+)_/);
    if (!m) continue;
    const [, territory, x, y, crs] = m;
    counts.set(`${territory} ${crs}`, (counts.get(`${territory} ${crs}`) ?? 0) + 1);
    // Coin nord-ouest dans le nom → ligne du coin sud-ouest = Y − 1.
    if (crs in cells) cells[crs].push([Number(x), Number(y) - 1]);
  }
  const features = [];
  for (const [crs, list] of Object.entries(cells)) {
    // Une dalle publiée par plusieurs zones (recouvrements de livraison) ne compte qu'une fois.
    const unique = [...new Map(list.map(c => [`${c[0]},${c[1]}`, c])).values()];
    const toLonLat = proj4(PROJ[crs], 'EPSG:4326').forward;
    const polygons = squareGridCoverage(unique, 1000, toLonLat, roundLonLat);
    if (polygons.length) features.push({ type: 'Feature', properties: { crs }, geometry: { type: 'MultiPolygon', coordinates: polygons } });
  }
  const stats = [...counts.entries()].map(([key, tiles]) => {
    const [territory, crs] = key.split(' ');
    return { territory, crs, tiles, kept: crs in cells };
  });
  return { stats, tiles: names.length, coverage: { type: 'FeatureCollection', features } };
}
