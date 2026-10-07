/** Emprise en mètres dans le SCR natif de la dalle. */
export interface TileBounds {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

/** Fichier source recoupant une dalle de 1 km ; `rank` = priorité de son jeu (0 = meilleur). */
export interface TileCandidate {
  url: string;
  bounds: TileBounds;
  rank: number;
}

/** Recouvrement minimal d'un fichier avec la dalle (1 % de 1 km²) : écarte les liserés de bord. */
const MIN_OVERLAP_M2 = 10_000;

/**
 * Ordre de téléchargement des fichiers d'une dalle : fichier sous le centre de
 * la dalle d'abord, puis jeu prioritaire (plus récent / dense), puis le plus
 * proche du centre. Le premier fichier téléchargé avec succès sert la dalle.
 */
export function rankTileCandidates(candidates: TileCandidate[], tile: TileBounds): string[] {
  const centerE = (tile.minE + tile.maxE) / 2;
  const centerN = (tile.minN + tile.maxN) / 2;
  const scored = [];
  for (const candidate of candidates) {
    const { bounds } = candidate;
    const overlap =
      Math.max(0, Math.min(bounds.maxE, tile.maxE) - Math.max(bounds.minE, tile.minE)) *
      Math.max(0, Math.min(bounds.maxN, tile.maxN) - Math.max(bounds.minN, tile.minN));
    const containsCenter = centerE >= bounds.minE && centerE < bounds.maxE && centerN >= bounds.minN && centerN < bounds.maxN;
    if (!containsCenter && overlap < MIN_OVERLAP_M2) continue;
    const distance = Math.hypot((bounds.minE + bounds.maxE) / 2 - centerE, (bounds.minN + bounds.maxN) / 2 - centerN);
    scored.push({ url: candidate.url, rank: candidate.rank, containsCenter, distance });
  }
  scored.sort((a, b) => Number(b.containsCenter) - Number(a.containsCenter) || a.rank - b.rank || a.distance - b.distance);
  return Array.from(new Set(scored.map(s => s.url)));
}

/** Masque hex (4 cellules par caractère, bit 0 = première cellule) : la cellule `bit` est-elle présente ? */
export function hasMaskBit(mask: string, bit: number): boolean {
  const nibble = parseInt(mask[bit >> 2] ?? '0', 16);
  return ((nibble >> (bit & 3)) & 1) === 1;
}

/** `fichier|minE|minN|maxE|maxN;…` → emprises. */
export function parseBoundedTiles(tiles: string | undefined): { name: string; bounds: TileBounds }[] {
  const out: { name: string; bounds: TileBounds }[] = [];
  if (!tiles) return out;
  for (const tile of tiles.split(';')) {
    const [name, minE, minN, maxE, maxN] = tile.split('|');
    if (name) out.push({ name, bounds: { minE: Number(minE), minN: Number(minN), maxE: Number(maxE), maxN: Number(maxN) } });
  }
  return out;
}

export function boundsIntersect(a: TileBounds, b: TileBounds): boolean {
  return a.maxE > b.minE && a.minE < b.maxE && a.maxN > b.minN && a.minN < b.maxN;
}

function sameBounds(a: TileBounds, b: TileBounds): boolean {
  return a.minE === b.minE && a.minN === b.minN && a.maxE === b.maxE && a.maxN === b.maxN;
}

/**
 * Fichiers d'une dalle-fichier (emprise exacte d'un fichier de l'index) : ceux
 * de cette emprise, jeu prioritaire d'abord. Aucun repli sur un fichier voisin :
 * la dalle montrée au survol est celle qui est téléchargée.
 */
export function rankFootprintCandidates(candidates: TileCandidate[], footprint: TileBounds): string[] {
  const exact = candidates.filter((candidate) => sameBounds(candidate.bounds, footprint));
  exact.sort((a, b) => a.rank - b.rank);
  return Array.from(new Set(exact.map((candidate) => candidate.url)));
}

/** Côté des carrés de l'index spatial des emprises stockées. */
const BUCKET_M = 2_000;

const bucketKey = (col: number, row: number) => `${col}:${row}`;

/** Index spatial (carrés de 2 km) d'emprises stockées, pour la recherche sous un point. */
export function bucketTileBounds(tiles: readonly { bounds: TileBounds }[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  tiles.forEach(({ bounds }, index) => {
    for (let col = Math.floor(bounds.minE / BUCKET_M); col <= Math.floor(bounds.maxE / BUCKET_M); col++) {
      for (let row = Math.floor(bounds.minN / BUCKET_M); row <= Math.floor(bounds.maxN / BUCKET_M); row++) {
        const key = bucketKey(col, row);
        const list = buckets.get(key);
        if (list) list.push(index);
        else buckets.set(key, [index]);
      }
    }
  });
  return buckets;
}

/** Emprise stockée contenant le point (la mieux centrée sur lui si plusieurs se chevauchent), null sinon. */
export function findTileBoundsAt(
  tiles: readonly { bounds: TileBounds }[],
  buckets: Map<string, number[]>,
  east: number,
  north: number,
): TileBounds | null {
  let best: TileBounds | null = null;
  let bestDistance = Infinity;
  for (const index of buckets.get(bucketKey(Math.floor(east / BUCKET_M), Math.floor(north / BUCKET_M))) ?? []) {
    const { bounds } = tiles[index]!;
    if (east < bounds.minE || east >= bounds.maxE || north < bounds.minN || north >= bounds.maxN) continue;
    const distance = Math.hypot((bounds.minE + bounds.maxE) / 2 - east, (bounds.minN + bounds.maxN) / 2 - north);
    if (distance < bestDistance) {
      best = bounds;
      bestDistance = distance;
    }
  }
  return best;
}
