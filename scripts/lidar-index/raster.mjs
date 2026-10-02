// Contours d'une grille binaire de couverture → polygones (anneaux extérieurs + trous).
//
// Les cellules couvertes sont dissoutes en polygones disjoints : un remplissage
// semi-transparent (overlay vert 18 %) ne doit jamais se superposer à lui-même.

/**
 * @param {Uint8Array} grid  w*h, 1 = couvert ; ligne 0 en haut (nord), y vers le bas.
 * @returns {number[][][][]} polygones → anneaux → sommets [x, y] en coins de cellules.
 *   Anneau extérieur horaire à l'écran (y vers le bas), trous anti-horaires.
 */
export function traceCoverage(grid, w, h) {
  const filled = (c, r) => c >= 0 && r >= 0 && c < w && r < h && grid[r * w + c] === 1;
  const W1 = w + 1;
  const key = (x, y) => y * W1 + x;
  // Arêtes orientées, cellule couverte à droite du sens de parcours (repère écran).
  const out = new Map(); // sommet → [dir, ...] ; dir 0=E 1=S 2=O 3=N
  let edgeCount = 0;
  const add = (x, y, dir) => {
    const k = key(x, y);
    const list = out.get(k);
    if (list) list.push(dir); else out.set(k, [dir]);
    edgeCount++;
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (grid[r * w + c] !== 1) continue;
      if (!filled(c, r - 1)) add(c, r, 0);
      if (!filled(c + 1, r)) add(c + 1, r, 1);
      if (!filled(c, r + 1)) add(c + 1, r + 1, 2);
      if (!filled(c - 1, r)) add(c, r + 1, 3);
    }
  }
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const rings = [];
  for (const [startKey, startList] of out) {
    while (startList.length > 0) {
      const d0 = startList.pop();
      edgeCount--;
      let x = startKey % W1;
      let y = (startKey - x) / W1;
      let dir = d0;
      const ring = [];
      for (;;) {
        x += DX[dir];
        y += DY[dir];
        const k = key(x, y);
        const list = out.get(k) ?? [];
        // Point-selle : on tourne à droite en priorité (les cellules en diagonale
        // restent des polygones distincts qui se touchent par un sommet).
        let next = -1;
        for (const turn of [1, 0, 3]) {
          const cand = (dir + turn) % 4;
          if (k === startKey && cand === d0) { next = -2; break; }
          const i = list.indexOf(cand);
          if (i >= 0) { list.splice(i, 1); edgeCount--; next = cand; break; }
        }
        if (next === -2) {
          if (dir !== d0) ring.push([x, y]);
          break;
        }
        if (next < 0) throw new Error('traceCoverage: anneau ouvert');
        if (next !== dir) ring.push([x, y]);
        dir = next;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  if (edgeCount !== 0) throw new Error(`traceCoverage: ${edgeCount} arêtes orphelines`);
  return groupRings(rings);
}

// Aire signée en repère écran (y vers le bas) : > 0 pour un anneau horaire.
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return a / 2;
}

function contains(ring, px, py) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function groupRings(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area > 0) outers.push({ ring, area, box: bbox(ring), holes: [] });
    else holes.push(ring);
  }
  outers.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    // Point au centre de la cellule couverte qui borde la première arête du
    // trou (à sa droite) : jamais sur une ligne de grille.
    const [ax, ay] = hole[0];
    const [bx, by] = hole[1];
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    const px = ax + dx * 0.5 - dy * 0.25;
    const py = ay + dy * 0.5 + dx * 0.25;
    const owner = outers.find(o => px > o.box.minX && px < o.box.maxX && py > o.box.minY && py < o.box.maxY && contains(o.ring, px, py));
    if (!owner) throw new Error('traceCoverage: trou sans anneau extérieur');
    owner.holes.push(hole);
  }
  return outers.map(o => [o.ring, ...o.holes]);
}
