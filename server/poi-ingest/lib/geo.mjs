/**
 * RedView — test d'appartenance à un territoire, sans dépendance externe.
 *
 * Pourquoi pas une simple boîte englobante : la boîte France
 * (`-5.6, 41.2 → 9.9, 51.4`) contient Bâle, Genève, Milan, Bruxelles et
 * Barcelone. Filtrer AllThePlaces dessus a ramené 569 076 « lieux français »
 * là où il n'y en a que 286 587 — un facteur 2 d'erreur, dont des pharmacies
 * italiennes et des arbres bâlois.
 *
 * Pourquoi pas un point-dans-polygone naïf : le polygone France compte
 * 69 000 sommets. Le tester sur des millions de points en JavaScript pur
 * coûte des dizaines de milliards d'opérations.
 *
 * Solution : rasteriser le polygone une fois (remplissage par balayage),
 * puis répondre en O(1) par lecture de tableau.
 */

/**
 * Rasterise un MultiPolygon GeoJSON en masque booléen.
 *
 * @param {object} multiPolygon  géométrie GeoJSON `MultiPolygon`
 * @param {object} [opts]
 * @param {number} [opts.res]    résolution en degrés (0.002 ≈ 220 m)
 * @returns {{ contains(lon:number, lat:number):boolean, bbox:number[], cells:number }}
 */
export function rasterizeMultiPolygon(multiPolygon, { res = 0.002 } = {}) {
  const polys = multiPolygon.coordinates || [];

  // Boîte englobante réelle du polygone.
  let lon0 = Infinity, lat0 = Infinity, lon1 = -Infinity, lat1 = -Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < lon0) lon0 = x;
        if (x > lon1) lon1 = x;
        if (y < lat0) lat0 = y;
        if (y > lat1) lat1 = y;
      }
    }
  }
  if (!Number.isFinite(lon0)) throw new Error('MultiPolygon vide');

  // Marge d'une cellule pour que les points juste à l'extérieur restent testables.
  lon0 -= res; lat0 -= res; lon1 += res; lat1 += res;
  const nx = Math.ceil((lon1 - lon0) / res);
  const ny = Math.ceil((lat1 - lat0) / res);
  const mask = new Uint8Array(nx * ny);

  for (const poly of polys) {
    // Toutes les arêtes du polygone, anneaux extérieurs ET trous : la règle
    // pair-impair appliquée sur l'ensemble des arêtes gère les trous
    // gratuitement (un trou produit deux intersections qui s'annulent).
    const edges = [];
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        if (y1 === y2) continue; // arête horizontale : ne croise aucun balayage
        edges.push({
          yLo: Math.min(y1, y2),
          yHi: Math.max(y1, y2),
          x1, y1,
          inv: (x2 - x1) / (y2 - y1),
        });
      }
    }
    if (!edges.length) continue;

    const xs = [];
    for (let y = 0; y < ny; y++) {
      const lat = lat0 + (y + 0.5) * res;
      xs.length = 0;
      for (const e of edges) {
        if (lat < e.yLo || lat >= e.yHi) continue;
        xs.push(e.x1 + (lat - e.y1) * e.inv);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let i0 = Math.ceil((xs[k] - lon0) / res - 0.5);
        let i1 = Math.floor((xs[k + 1] - lon0) / res - 0.5);
        if (i1 < 0 || i0 >= nx) continue;
        if (i0 < 0) i0 = 0;
        if (i1 >= nx) i1 = nx - 1;
        const base = y * nx;
        for (let x = i0; x <= i1; x++) mask[base + x] = 1;
      }
    }
  }

  let cells = 0;
  for (let i = 0; i < mask.length; i++) cells += mask[i];

  return {
    bbox: [lon0, lat0, lon1, lat1],
    cells,
    contains(lon, lat) {
      if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) return false;
      const x = Math.floor((lon - lon0) / res);
      const y = Math.floor((lat - lat0) / res);
      if (x < 0 || x >= nx || y < 0 || y >= ny) return false;
      return mask[y * nx + x] === 1;
    },
  };
}
