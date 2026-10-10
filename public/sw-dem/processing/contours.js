// ---------------------------------------------------------------------------
// Courbes de niveau — calcul pur : tuile DEM → lignes → tuile vectorielle MVT
//
// Une courbe drapée est dessinée sur le maillage du terrain : elle n'est de
// niveau que si elle est l'isoligne exacte de la surface que Mapbox affiche.
// Les courbes de Mapbox (`mapbox-terrain-v2`, MNT grossier et généralisé)
// montaient et descendaient sur le relief LiDAR ; des courbes tirées d'un
// autre DEM que celui du maillage (le MNT sous un relief MNS 0,40 m), ou d'un
// DEM lissé, ondulaient encore de plusieurs mètres. Ici, on reproduit la
// surface de GL JS v3 (Terrain, `createGrid` + `tileUvToDemSample`) :
//
//  - un sommet par pixel DEM : la tuile de rendu de 512 px (128 cellules) lit
//    le quart de la tuile DEM z − 1, donc le pixel i est le sommet de position
//    i (son coin, pas son centre), et l'altitude d'un sommet est celle du pixel,
//    sans interpolation ;
//  - les sommets 256 (bord est / sud) sont la bordure de la texture DEM : le
//    premier pixel de la voisine, ou le pixel de bord recopié tant que la
//    voisine n'est pas chargée (DEMData de Mapbox fait de même) ;
//  - chaque cellule est coupée par la diagonale haut-droite → bas-gauche :
//    triangles (TR, TL, BL) et (BL, BR, TR) ; la surface est linéaire dans
//    chaque triangle.
//
// Étapes : marching triangles sur cette surface (segments orientés, le haut à
// gauche, recousus en lignes par niveau comme d3-contour ; un point de bord est
// interpolé dans le sens canonique du bord pour être identique des deux côtés),
// Douglas-Peucker à 0,1 px, anneaux minuscules retirés, découpage à la tuile
// vectorielle demandée (un quart de la tuile DEM : runtime/contour-handler.js),
// encodage Mapbox Vector Tile v2 : une couche `contour`, une entité
// multiligne par niveau, propriétés `ele` (m) et `index` (comme
// mapbox-terrain-v2, pour que le filtre des couches reste le même).
//
// Fonctions sans état, chargées aussi par les tests (test/service-worker/).
// ---------------------------------------------------------------------------

const CONTOUR_TILE_EXTENT = 4096;
const CONTOUR_LAYER_NAME = 'contour';
const CONTOUR_DEM_SIZE = 256;
/** Tolérance de Douglas-Peucker, en pixels DEM (≈ 0,35 m d'altitude sur une pente à 45° à z15). */
const CONTOUR_SIMPLIFY_PX = 0.1;
/** Anneau fermé plus petit que ce côté (pixels DEM) : une bosse d'un pixel, pas un sommet. */
const CONTOUR_MIN_RING_PX = 1.5;
/** Altitude sous laquelle un sommet est tenu pour sans donnée (Terrain-RGB à zéro = −10 000 m). */
const CONTOUR_NODATA_BELOW = -1000;

/** Équidistance de base d'une tuile vectorielle de zoom `z` : la plus fine que les couches peuvent filtrer. */
function contourBaseInterval(z) {
  return z <= 12 ? 20 : 10;
}

/** Voisines lues pour la bordure est / sud de la texture DEM : [dx, dy]. */
const CONTOUR_NEIGHBOUR_OFFSETS = {
  e: [1, 0], s: [0, 1], se: [1, 1],
};

/**
 * Sommets du maillage : (256 + 1)², le sommet (i, j) à la position (i, j) en
 * pixels DEM. La rangée / colonne 256 vient des voisines est / sud / sud-est
 * (Float32Array 256²), ou recopie le bord de la tuile quand elles manquent.
 */
function buildContourGrid(own, neighbours) {
  const S = CONTOUR_DEM_SIZE;
  const W = S + 1;
  const grid = new Float32Array(W * W);
  const east = neighbours?.e;
  const south = neighbours?.s;
  const southEast = neighbours?.se;
  for (let j = 0; j < S; j++) {
    grid.set(own.subarray(j * S, j * S + S), j * W);
    grid[j * W + S] = east ? east[j * S] : own[j * S + S - 1];
  }
  for (let i = 0; i < S; i++) {
    grid[S * W + i] = south ? south[i] : own[(S - 1) * S + i];
  }
  grid[S * W + S] = southEast ? southEast[0] : own[S * S - 1];
  return { grid, width: W };
}

/**
 * Marching triangles sur la surface triangulée de Mapbox, à chaque multiple de
 * `interval`. Renvoie Map<altitude, number[][]> : des lignes en pixels DEM
 * [x0, y0, x1, y1, …] (une ligne fermée répète son premier point).
 */
function traceContours(grid, W, interval) {
  const levels = new Map();

  function stateFor(level) {
    let state = levels.get(level);
    if (!state) {
      state = { byStart: new Map(), byEnd: new Map(), lines: [] };
      levels.set(level, state);
    }
    return state;
  }

  function flatten(frag) {
    const out = [];
    for (let i = frag.head.length - 2; i >= 0; i -= 2) out.push(frag.head[i], frag.head[i + 1]);
    for (let i = 0; i < frag.tail.length; i++) out.push(frag.tail[i]);
    return out;
  }

  function addSegment(state, sk, sx, sy, ek, ex, ey) {
    const f = state.byEnd.get(sk);
    const g = state.byStart.get(ek);
    if (f && g) {
      state.byEnd.delete(sk);
      state.byStart.delete(ek);
      if (f === g) {
        f.tail.push(ex, ey);
        state.lines.push(flatten(f));
        return;
      }
      const rest = flatten(g);
      for (let i = 0; i < rest.length; i++) f.tail.push(rest[i]);
      f.end = g.end;
      state.byEnd.set(f.end, f);
    } else if (f) {
      state.byEnd.delete(sk);
      f.tail.push(ex, ey);
      f.end = ek;
      state.byEnd.set(ek, f);
    } else if (g) {
      state.byStart.delete(ek);
      g.head.push(sx, sy);
      g.start = sk;
      state.byStart.set(sk, g);
    } else {
      const frag = { start: sk, end: ek, head: [], tail: [sx, sy, ex, ey] };
      state.byStart.set(sk, frag);
      state.byEnd.set(ek, frag);
    }
  }

  // Triangle courant, sommets dans le sens horaire (y vers le bas) ; le bord k
  // va du sommet k au sommet k + 1 et porte la clé tk[k].
  const tx = [0, 0, 0];
  const ty = [0, 0, 0];
  const tv = [0, 0, 0];
  const tn = [0, 0, 0]; // indice du sommet dans la grille : sens canonique des bords
  const tk = [0, 0, 0];

  function setVertex(k, x, y, n, value, edgeKey) {
    tx[k] = x; ty[k] = y; tn[k] = n; tv[k] = value; tk[k] = edgeKey;
  }

  function triangle(level) {
    let sk = -1, sx = 0, sy = 0, ek = -1, ex = 0, ey = 0;
    for (let a = 0; a < 3; a++) {
      const b = a === 2 ? 0 : a + 1;
      const ha = tv[a] >= level;
      const hb = tv[b] >= level;
      if (ha === hb) continue;
      // Toujours interpolé du sommet d'indice le plus petit vers l'autre : le
      // même point, au bit près, pour les deux triangles qui partagent le bord.
      const lo = tn[a] < tn[b] ? a : b;
      const hi = lo === a ? b : a;
      const t = (level - tv[lo]) / (tv[hi] - tv[lo]);
      const x = tx[lo] + t * (tx[hi] - tx[lo]);
      const y = ty[lo] + t * (ty[hi] - ty[lo]);
      if (hb) { sk = tk[a]; sx = x; sy = y; } // bas → haut : entrée
      else { ek = tk[a]; ex = x; ey = y; }
    }
    if (sk >= 0 && ek >= 0) addSegment(stateFor(level), sk, sx, sy, ek, ex, ey);
  }

  function levelsOfTriangle() {
    const lo = Math.min(tv[0], tv[1], tv[2]);
    const hi = Math.max(tv[0], tv[1], tv[2]);
    const kLast = Math.floor(hi / interval);
    for (let k = Math.floor(lo / interval) + 1; k <= kLast; k++) triangle(k * interval);
  }

  for (let cy = 0; cy < W - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const nTL = cy * W + cx;
      const nTR = nTL + 1;
      const nBL = nTL + W;
      const nBR = nBL + 1;
      const vTL = grid[nTL], vTR = grid[nTR], vBL = grid[nBL], vBR = grid[nBR];
      // Clés de bord : 3·sommet + 0 (horizontal, vers la droite), + 1 (vertical,
      // vers le bas), + 2 (diagonale de la cellule, de TR à BL).
      const kTop = 3 * nTL, kLeft = 3 * nTL + 1, kDiag = 3 * nTL + 2;
      const kRight = 3 * nTR + 1, kBottom = 3 * nBL;
      // Triangle haut-gauche : TL → TR → BL.
      if (vTL >= CONTOUR_NODATA_BELOW && vTR >= CONTOUR_NODATA_BELOW && vBL >= CONTOUR_NODATA_BELOW) {
        setVertex(0, cx, cy, nTL, vTL, kTop);
        setVertex(1, cx + 1, cy, nTR, vTR, kDiag);
        setVertex(2, cx, cy + 1, nBL, vBL, kLeft);
        levelsOfTriangle();
      }
      // Triangle bas-droit : TR → BR → BL.
      if (vTR >= CONTOUR_NODATA_BELOW && vBR >= CONTOUR_NODATA_BELOW && vBL >= CONTOUR_NODATA_BELOW) {
        setVertex(0, cx + 1, cy, nTR, vTR, kRight);
        setVertex(1, cx + 1, cy + 1, nBR, vBR, kBottom);
        setVertex(2, cx, cy + 1, nBL, vBL, kDiag);
        levelsOfTriangle();
      }
    }
  }

  const out = new Map();
  for (const [level, state] of levels) {
    const lines = state.lines;
    for (const frag of state.byStart.values()) lines.push(flatten(frag));
    if (lines.length) out.set(level, lines);
  }
  return out;
}

/**
 * Douglas-Peucker itératif sur [x0, y0, x1, y1, …] ; garde les extrémités (sur
 * le bord de la tuile pour une ligne ouverte : le raccord avec la voisine reste exact).
 */
function simplifyContourLine(pts, tolerance) {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d2;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push(a, maxI, maxI, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

function isTinyClosedRing(pts, minSide) {
  const n = pts.length;
  if (n < 4) return true;
  if (pts[0] !== pts[n - 2] || pts[1] !== pts[n - 1]) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  return maxX - minX < minSide && maxY - minY < minSide;
}

/**
 * Lignes de niveau d'une tuile DEM, en pixels DEM (0..256 = la tuile),
 * simplifiées : Map<altitude, number[][]>. `interval` : équidistance de base
 * (contourBaseInterval du zoom de la tuile vectorielle). Les voisines (`e`, `s`,
 * `se`) donnent la bordure est / sud, comme la texture DEM de Mapbox.
 */
function computeContourLines(own, neighbours, interval) {
  const { grid, width } = buildContourGrid(own, neighbours);
  const traced = traceContours(grid, width, interval);
  const result = new Map();
  for (const [level, lines] of traced) {
    const kept = [];
    for (const line of lines) {
      if (isTinyClosedRing(line, CONTOUR_MIN_RING_PX)) continue;
      kept.push(simplifyContourLine(line, CONTOUR_SIMPLIFY_PX));
    }
    if (kept.length) result.set(level, kept);
  }
  return result;
}

/** Marge gardée autour d'une tuile vectorielle (unités MVT) : jointures des lignes au bord. */
const CONTOUR_TILE_BUFFER = 80;

/**
 * Lignes d'une tuile DEM (pixels DEM) → coordonnées MVT entières de la tuile
 * vectorielle qui en couvre la cellule (qx, qy) d'un découpage en 2^dz,
 * découpées à la tuile plus CONTOUR_TILE_BUFFER.
 */
function projectContourLines(linesByLevel, dz = 0, qx = 0, qy = 0) {
  const scale = (CONTOUR_TILE_EXTENT / CONTOUR_DEM_SIZE) * (1 << dz);
  const ox = qx * CONTOUR_TILE_EXTENT;
  const oy = qy * CONTOUR_TILE_EXTENT;
  const lo = -CONTOUR_TILE_BUFFER;
  const hi = CONTOUR_TILE_EXTENT + CONTOUR_TILE_BUFFER;
  const result = new Map();
  for (const [level, lines] of linesByLevel) {
    const kept = [];
    for (const line of lines) {
      let run = null;
      let lastX = NaN;
      let lastY = NaN;
      const push = (x, y) => {
        const rx = Math.round(x);
        const ry = Math.round(y);
        if (rx === lastX && ry === lastY) return;
        run.push(rx, ry);
        lastX = rx;
        lastY = ry;
      };
      const close = () => {
        if (run && run.length >= 4) kept.push(run);
        run = null;
        lastX = NaN;
        lastY = NaN;
      };
      let px = line[0] * scale - ox;
      let py = line[1] * scale - oy;
      for (let i = 2; i < line.length; i += 2) {
        const x = line[i] * scale - ox;
        const y = line[i + 1] * scale - oy;
        // Liang-Barsky : la partie du segment (px, py) → (x, y) dans la boîte.
        const dx = x - px;
        const dy = y - py;
        let t0 = 0;
        let t1 = 1;
        let inside = true;
        for (const [p, q] of [[-dx, px - lo], [dx, hi - px], [-dy, py - lo], [dy, hi - py]]) {
          if (p === 0) {
            if (q < 0) { inside = false; break; }
          } else {
            const t = q / p;
            if (p < 0) { if (t > t1) { inside = false; break; } if (t > t0) t0 = t; }
            else { if (t < t0) { inside = false; break; } if (t < t1) t1 = t; }
          }
        }
        if (!inside) {
          close();
        } else {
          if (t0 > 0) close();
          if (!run) { run = []; push(px + t0 * dx, py + t0 * dy); }
          push(px + t1 * dx, py + t1 * dy);
          if (t1 < 1) close();
        }
        px = x;
        py = y;
      }
      close();
    }
    if (kept.length) result.set(level, kept);
  }
  return result;
}

// ── Encodage Mapbox Vector Tile v2 (protobuf) ─────────────────────────

function pbfVarint(out, value) {
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function pbfZigzag(n) {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function pbfKey(out, field, wireType) {
  pbfVarint(out, (field << 3) | wireType);
}

function pbfBytes(out, field, bytes) {
  pbfKey(out, field, 2);
  pbfVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function pbfString(out, field, text) {
  pbfBytes(out, field, new TextEncoder().encode(text));
}

function pbfPacked(out, field, values) {
  const body = [];
  for (const v of values) pbfVarint(body, v);
  pbfBytes(out, field, body);
}

/** Indice `index` façon mapbox-terrain-v2 : 5 sur les courbes maîtresses (multiples de 50 m). */
function contourIndexFor(level) {
  return level % 50 === 0 ? 5 : 1;
}

/** Tuile MVT (Uint8Array) des lignes de `computeContourLines` ; vide quand il n'y a rien. */
function encodeContourTile(linesByLevel) {
  if (!linesByLevel || linesByLevel.size === 0) return new Uint8Array(0);
  const values = [];
  const valueIndex = new Map();
  const valueFor = (v) => {
    let idx = valueIndex.get(v);
    if (idx === undefined) {
      idx = values.length;
      values.push(v);
      valueIndex.set(v, idx);
    }
    return idx;
  };

  const layer = [];
  pbfKey(layer, 15, 0); pbfVarint(layer, 2); // version
  pbfString(layer, 1, CONTOUR_LAYER_NAME);
  const levels = [...linesByLevel.keys()].sort((a, b) => a - b);
  let id = 1;
  for (const level of levels) {
    const geometry = [];
    let cx = 0;
    let cy = 0;
    for (const line of linesByLevel.get(level)) {
      const n = line.length / 2;
      geometry.push((1 << 3) | 1); // MoveTo ×1
      geometry.push(pbfZigzag(line[0] - cx), pbfZigzag(line[1] - cy));
      cx = line[0];
      cy = line[1];
      geometry.push(((n - 1) << 3) | 2); // LineTo ×(n − 1)
      for (let i = 1; i < n; i++) {
        const x = line[i * 2];
        const y = line[i * 2 + 1];
        geometry.push(pbfZigzag(x - cx), pbfZigzag(y - cy));
        cx = x;
        cy = y;
      }
    }
    const feature = [];
    pbfKey(feature, 1, 0); pbfVarint(feature, id++);
    pbfPacked(feature, 2, [0, valueFor(level), 1, valueFor(contourIndexFor(level))]);
    pbfKey(feature, 3, 0); pbfVarint(feature, 2); // LINESTRING
    pbfPacked(feature, 4, geometry);
    pbfBytes(layer, 2, feature);
  }
  pbfString(layer, 3, 'ele');
  pbfString(layer, 3, 'index');
  for (const v of values) {
    const value = [];
    pbfKey(value, 6, 0); pbfVarint(value, pbfZigzag(v)); // sint_value
    pbfBytes(layer, 4, value);
  }
  pbfKey(layer, 5, 0); pbfVarint(layer, CONTOUR_TILE_EXTENT);

  const tile = [];
  pbfBytes(tile, 3, layer);
  return Uint8Array.from(tile);
}

/**
 * Tuile MVT des courbes de niveau de la tuile vectorielle `z` couvrant la
 * cellule (qx, qy) d'un découpage en 2^dz de la tuile DEM `own` (+ voisines).
 */
function buildContourTileBytes(own, neighbours, z, dz = 0, qx = 0, qy = 0) {
  return encodeContourTile(projectContourLines(computeContourLines(own, neighbours, contourBaseInterval(z)), dz, qx, qy));
}
