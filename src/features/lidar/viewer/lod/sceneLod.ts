// ============================================
// LOD de la scène : octrees additifs multi-tuiles, chargés en flux et sous budget
// ============================================
//
// Chaque tuile est un octree additif (voir lodTile.ts) dont les blocs de
// nœuds vivent dans le cache LOD de l'OPFS. À chaque image :
//  1. les racines des tuiles visibles sont toujours gardées (aucune tuile ne
//     devient vide), puis les nœuds sont visités par rang décroissant et
//     gardés tant qu'ils tiennent dans le budget de points. L'espacement
//     projeté d'un nœud est l'espacement de ses points vu depuis le point le
//     plus proche de ses bornes (px de l'écran) ; le nœud est raffiné tant
//     qu'il dépasse `TARGET_SPACING_PX`. Son rang est cet espacement pondéré
//     par le raccourci de perspective : une surface plane vue en incidence
//     rasante tasse ses points sur peu de lignes de pixels, donc sous un
//     budget serré elle cède la place aux surfaces vues de face. Avec assez
//     de budget, chaque nœud atteint la même cible, quel que soit l'angle ;
//  2. toute la cible est sélectionnée dans la table des nœuds, chargés ou
//     non, et compte dans le budget : ce qui est à l'écran converge vers elle
//     sans remaniement à l'arrivée des niveaux plus fins. Les nœuds manquants
//     sont chargés par rang, du grossier au fin (un nœud attend les points de
//     son parent, qui resserrent ses bornes), et un nœud n'est dessiné que
//     sous un parent dessiné ;
//  3. la résidence est bornée par un budget de pool ; les nœuds sélectionnés
//     le moins récemment sont évincés d'abord, jamais les racines de tuiles
//     (pas de sol vide en tournant).
// Les bornes d'un nœud partent du cube de l'octree découpé aux bornes de la
// tuile et se resserrent sur ses points une fois chargé : ceux-ci
// échantillonnent chaque cellule occupée de la grille du nœud, donc chaque
// point du sous-arbre se trouve à moins d'une cellule d'eux (≤ 1,2 cellule
// mesuré sur les tuiles COPC de l'IGN ; on en garde 2). Des bornes serrées
// éliminent davantage et donnent les vraies distances là où un cube est
// surtout de l'air.

import { readLodNodeBlock, type OpenedLodTile } from '../../lib/lodCache';
import { extractFrustumPlanes, frustumTestAABB, OUTSIDE, type FrustumPlanes } from './frustum';
import { LOD_POINT_STRIDE, lodNodeCube, lodNodeSpacing, type LodNode } from './lodTile';

/** Raffine tant que l'espacement des points d'un nœud se projette au-delà de cette valeur (px de l'écran). */
const TARGET_SPACING_PX = 1.25;
/** Un nœud raffiné ne se replie que quand son espacement passe sous cette fraction de la cible. */
const UNREFINE_FACTOR = 0.7;
/** Les nœuds gardés à l'image précédente (dessinés ou en chargement) passent devant… */
const KEEP_PRIORITY_BOOST = 1.3;
/** …et les nouveaux nœuds ne peuvent remplir que cette part du budget : les deux n'échangent jamais leur place d'une image à l'autre. */
const NEW_NODE_BUDGET_SHARE = 0.97;
const MAX_CONCURRENT_LOADS = 6;
/**
 * Plancher du rapport d'aires projetées utilisé par le poids du raccourci de
 * perspective (sa racine carrée pondère l'espacement : ≥ 0,39, soit au plus
 * 2,6× plus grossier).
 */
const MIN_FORESHORTENING = 0.15;
/** Les bornes du contenu s'élargissent de ce nombre de cellules de grille pour contenir tout le sous-arbre du nœud. */
export const CONTENT_MARGIN_CELLS = 2;
/** Plancher de distance (m) de l'espacement projeté : le plan proche de la caméra. */
const MIN_VIEW_DISTANCE = 0.05;
/** Les bornes de la tuile sont élargies de cette marge (m) avant de découper les cubes de l'octree. */
const TILE_BOUNDS_EPSILON = 0.01;

type SceneNodeState = 'idle' | 'loading' | 'resident' | 'failed';

export interface SceneNode {
  id: number;
  tileIndex: number;
  entry: LodNode;
  depth: number;
  /**
   * Bornes prudentes dans le repère de rendu (x est, y haut, z = −nord) du
   * nœud et de tout son sous-arbre, relatives au centre de la scène ; elles
   * se resserrent à mesure que le nœud et ses ancêtres sont chargés.
   */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /**
   * Position dans le repère de rendu du coin minimal du cube de quantification :
   * renderPos = origin + (qx·s, qz·s, −qy·s), q ∈ [0, 1].
   */
  originX: number; originY: number; originZ: number;
  size: number;
  /** Cellule de grille du sous-échantillonnage du nœud (espacement nominal du niveau). */
  cell: number;
  /** Espacement des points sur une surface, pour le test d'espacement projeté. */
  spacing: number;
  /**
   * Espacement auquel les points du nœud grossissent là où aucun de ses
   * enfants n'est dessiné (taille de point adaptative) ; 0 pour les feuilles,
   * dont les points sont à pleine densité.
   */
  adaptiveSpacing: number;
  parent: number;
  children: number[];
  state: SceneNodeState;
  lastSelectedFrame: number;
  /** Dernière image où le nœud a été dessiné (hystérésis contre les échanges d'une image à l'autre). */
  lastDrawnFrame: number;
  /** Dernière image où les enfants du nœud ont été visités (hystérésis du raffinement). */
  refinedFrame: number;
  /** Dernière image où la zone du nœud était à l'écran : dessinée, ou vide sous un parent couvert. */
  coveredFrame: number;
  /** Espacement projeté (px de l'écran) et distance (m) de la dernière évaluation. */
  projectedSpacing: number;
  viewDistance: number;
  /** Octants (bit = x | y << 1 | z << 2, axes du SCR) dont l'enfant est dessiné à cette image. */
  childMask: number;
  /** Jeton de la dernière sélection de projeteurs d'ombre qui a atteint le nœud (voir `selectShadowCasters`). */
  shadowMark: number;
  /** Octants raffinés par un nœud de la dernière sélection de projeteurs d'ombre. */
  shadowChildMask: number;
  /** Vrai pour les ancêtres ajoutés parce que l'octree les a sautés (aucun point). */
  virtual: boolean;
}

export interface SceneFrameCenter {
  x: number;
  y: number;
  z: number;
}

/** Côté renderer du contrat de résidence. */
export interface SceneNodeUploader {
  /** Envoie un bloc de nœud ; renvoie false si le GPU l'a refusé (mémoire épuisée). */
  uploadNode(node: SceneNode, block: ArrayBuffer): boolean;
  releaseNode(node: SceneNode): void;
}

export interface SceneLodStats {
  selectedNodes: number;
  selectedPoints: number;
  /** Points de la sélection cible, nœuds encore en chargement compris. */
  targetPoints: number;
  residentNodes: number;
  residentPoints: number;
  pendingLoads: number;
  /** Blocs de nœuds envoyés depuis l'ouverture de la scène (rechargements après éviction compris). */
  uploadedNodes: number;
  totalPoints: number;
  totalNodes: number;
  pointBudget: number;
  poolBudget: number;
  frustumCulled: number;
}

/** Tas max d'identifiants de nœuds indexé par rang, sur tableaux typés (aucune allocation par insertion). */
class NodeHeap {
  private ids = new Int32Array(256);
  private keys = new Float64Array(256);
  size = 0;
  /** Clé de l'identifiant rendu par le dernier `pop()`. */
  topKey = 0;

  clear(): void {
    this.size = 0;
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      ids.set(this.ids);
      this.ids = ids;
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
    }
    const ids = this.ids;
    const keys = this.keys;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! >= key) break;
      ids[i] = ids[parent]!;
      keys[i] = keys[parent]!;
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    this.topKey = keys[0]!;
    const n = --this.size;
    if (n > 0) {
      const id = ids[n]!;
      const key = keys[n]!;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= n) break;
        const right = left + 1;
        const child = right < n && keys[right]! > keys[left]! ? right : left;
        if (keys[child]! <= key) break;
        ids[i] = ids[child]!;
        keys[i] = keys[child]!;
        i = child;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

function octantOf(entry: Pick<LodNode, 'x' | 'y' | 'z'>): number {
  return (entry.x & 1) | ((entry.y & 1) << 1) | ((entry.z & 1) << 2);
}

/** Réduit `node` à son intersection avec `box` ; indique s'il a changé. */
function clipNode(node: SceneNode, box: Box): boolean {
  let changed = false;
  if (box.minX > node.minX && box.minX <= node.maxX) { node.minX = box.minX; changed = true; }
  if (box.maxX < node.maxX && box.maxX >= node.minX) { node.maxX = box.maxX; changed = true; }
  if (box.minY > node.minY && box.minY <= node.maxY) { node.minY = box.minY; changed = true; }
  if (box.maxY < node.maxY && box.maxY >= node.minY) { node.maxY = box.maxY; changed = true; }
  if (box.minZ > node.minZ && box.minZ <= node.maxZ) { node.minZ = box.minZ; changed = true; }
  if (box.maxZ < node.maxZ && box.maxZ >= node.minZ) { node.maxZ = box.maxZ; changed = true; }
  return changed;
}

export class SceneLod {
  readonly nodes: SceneNode[] = [];
  private readonly tiles: OpenedLodTile[];
  private readonly roots: number[] = [];
  private readonly uploader: SceneNodeUploader;
  private readonly onNodeResident: () => void;

  private frameIndex = 0;
  private selected: SceneNode[] = [];
  private targetPoints = 0;
  private readonly heap = new NodeHeap();
  private readonly pending = new Map<number, number>();
  /** Brouillon de `pumpLoads` (aucune allocation par image) : identifiants en attente et leur rang par identifiant de nœud. */
  private readonly loadQueue: number[] = [];
  private pendingRank = new Float64Array(0);
  private inFlight = 0;
  private residentPoints = 0;
  private residentNodes = 0;
  /** Points/nœuds des chargements en cours, réservés pour que des chargements simultanés ne dépassent pas le pool. */
  private reservedPoints = 0;
  private reservedNodes = 0;
  /** Candidats à l'éviction (sélectionnés le moins récemment d'abord), construits au plus une fois par pompe de chargement. */
  private evictionQueue: SceneNode[] | null = null;
  private evictionCursor = 0;
  private pointBudget: number;
  private poolBudget: number;
  private readonly maxResidentNodes: number;
  private frustumCulled = 0;
  private uploadedNodes = 0;
  /** Jeton et file BFS de `selectShadowCasters`. */
  private shadowToken = 0;
  private readonly shadowQueue: number[] = [];
  private destroyed = false;
  readonly totalPoints: number;

  constructor(
    tiles: OpenedLodTile[],
    center: SceneFrameCenter,
    options: {
      pointBudget: number;
      /** Points gardés résidents sur le GPU. */
      poolBudget: number;
      /** Nœuds que le pool GPU peut contenir à la fois. */
      maxResidentNodes: number;
      uploader: SceneNodeUploader;
      /** Un nœud a fini de charger (ou a échoué) : l'appelant doit refaire un rendu. */
      onNodeResident: () => void;
    },
  ) {
    this.tiles = tiles;
    this.uploader = options.uploader;
    this.onNodeResident = options.onNodeResident;
    this.pointBudget = options.pointBudget;
    this.poolBudget = Math.max(options.poolBudget, options.pointBudget);
    this.maxResidentNodes = Math.max(1, options.maxResidentNodes);
    let total = 0;
    tiles.forEach((tile, tileIndex) => {
      total += tile.header.pointCount;
      this.addTile(tile, tileIndex, center);
    });
    this.totalPoints = total;
    this.pendingRank = new Float64Array(this.nodes.length);
  }

  private createNode(
    tileIndex: number,
    entry: LodNode,
    center: SceneFrameCenter,
    tileBox: Box,
    virtual: boolean,
  ): SceneNode {
    const tile = this.tiles[tileIndex]!;
    const header = tile.header;
    const cube = lodNodeCube(header, entry);
    // Absolute cube corner → render frame (float64 subtraction, exact enough).
    const minX = header.origin.x + cube.minX - center.x;
    const minY = header.origin.z + cube.minZ - center.z;
    const maxZ = -(header.origin.y + cube.minY - center.y);
    const size = cube.size;
    const cell = lodNodeSpacing(header, entry.depth);
    const node: SceneNode = {
      id: this.nodes.length,
      tileIndex,
      entry,
      depth: entry.depth,
      minX, minY, minZ: maxZ - size,
      maxX: minX + size, maxY: minY + size, maxZ,
      originX: minX, originY: minY, originZ: maxZ,
      size,
      cell,
      // Les feuilles gardent tous les points restants, elles sont donc plus
      // denses que l'espacement nominal de leur niveau : on l'estime d'après
      // le nombre de points (données de surface).
      spacing: entry.count > 0 ? Math.min(cell, size / Math.sqrt(entry.count)) : cell,
      adaptiveSpacing: 0,
      parent: -1,
      children: [],
      state: virtual ? 'resident' : 'idle',
      lastSelectedFrame: -1,
      lastDrawnFrame: -1,
      refinedFrame: -1,
      coveredFrame: -1,
      projectedSpacing: 0,
      viewDistance: 0,
      childMask: 0,
      shadowMark: 0,
      shadowChildMask: 0,
      virtual,
    };
    clipNode(node, tileBox);
    this.nodes.push(node);
    return node;
  }

  private addTile(tile: OpenedLodTile, tileIndex: number, center: SceneFrameCenter): void {
    const b = tile.header.bounds;
    const e = TILE_BOUNDS_EPSILON;
    const tileBox: Box = {
      minX: b.minX - center.x - e, maxX: b.maxX - center.x + e,
      minY: b.minZ - center.z - e, maxY: b.maxZ - center.z + e,
      minZ: -(b.maxY - center.y) - e, maxZ: -(b.minY - center.y) + e,
    };
    const byKey = new Map<string, SceneNode>();
    const keyOf = (d: number, x: number, y: number, z: number) => `${d}-${x}-${y}-${z}`;
    for (const entry of tile.nodes) {
      byKey.set(keyOf(entry.depth, entry.x, entry.y, entry.z), this.createNode(tileIndex, entry, center, tileBox, false));
    }
    // Relie les parents, en créant les ancêtres vides que l'octree a pu omettre.
    const ensure = (d: number, x: number, y: number, z: number): SceneNode => {
      const key = keyOf(d, x, y, z);
      let node = byKey.get(key);
      if (!node) {
        node = this.createNode(tileIndex, { depth: d, x, y, z, count: 0, byteOffset: 0 }, center, tileBox, true);
        byKey.set(key, node);
        if (d > 0) {
          const parent = ensure(d - 1, x >> 1, y >> 1, z >> 1);
          node.parent = parent.id;
          parent.children.push(node.id);
        }
      }
      return node;
    };
    for (const node of [...byKey.values()]) {
      if (node.depth === 0 || node.parent >= 0) continue;
      const entry = node.entry;
      const parent = ensure(entry.depth - 1, entry.x >> 1, entry.y >> 1, entry.z >> 1);
      node.parent = parent.id;
      parent.children.push(node.id);
    }
    for (const node of byKey.values()) {
      node.adaptiveSpacing = node.children.length > 0 ? node.spacing : 0;
    }
    const root = byKey.get(keyOf(0, 0, 0, 0));
    if (root) this.roots.push(root.id);
  }

  setPointBudget(points: number): void {
    this.pointBudget = Math.max(1, Math.floor(points));
  }

  setPoolBudget(points: number): void {
    this.poolBudget = Math.max(points, this.pointBudget);
  }

  /** Nœuds résidents à dessiner à cette image, de l'avant vers l'arrière. Valables jusqu'au prochain `update`. */
  getSelectedNodes(): readonly SceneNode[] {
    return this.selected;
  }

  /** Blocs de nœuds envoyés depuis l'ouverture de la scène : change dès que de nouveaux points deviennent résidents. */
  getUploadedNodes(): number {
    return this.uploadedNodes;
  }

  /** Aucun chargement en attente ni en cours : la sélection courante est définitive. */
  isIdle(): boolean {
    return this.pending.size === 0 && this.inFlight === 0;
  }

  getStats(): SceneLodStats {
    let selectedPoints = 0;
    for (const node of this.selected) selectedPoints += node.entry.count;
    return {
      selectedNodes: this.selected.length,
      selectedPoints,
      targetPoints: this.targetPoints,
      residentNodes: this.residentNodes,
      residentPoints: this.residentPoints,
      pendingLoads: this.pending.size + this.inFlight,
      uploadedNodes: this.uploadedNodes,
      totalPoints: this.totalPoints,
      totalNodes: this.nodes.length,
      pointBudget: this.pointBudget,
      poolBudget: this.poolBudget,
      frustumCulled: this.frustumCulled,
    };
  }

  /**
   * Fixe l'espacement projeté et la distance de vue du nœud ; renvoie son
   * rang : cet espacement pondéré par la racine carrée du raccourci de
   * perspective de ses bornes, c'est-à-dire leur aire projetée le long du
   * rayon de vue rapportée à leur emprise au sol (1 vu d'au-dessus ou de
   * face, → hauteur/largeur en incidence rasante pour une surface plane ;
   * les boîtes aussi hautes que larges restent à 1).
   */
  private evaluate(node: SceneNode, camX: number, camY: number, camZ: number, focalPx: number): number {
    const dx = (camX < node.minX ? node.minX : camX > node.maxX ? node.maxX : camX) - camX;
    const dy = (camY < node.minY ? node.minY : camY > node.maxY ? node.maxY : camY) - camY;
    const dz = (camZ < node.minZ ? node.minZ : camZ > node.maxZ ? node.maxZ : camZ) - camZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const projected = (node.spacing * focalPx) / Math.max(distance, MIN_VIEW_DISTANCE);
    node.viewDistance = distance;
    node.projectedSpacing = projected;
    if (distance < MIN_VIEW_DISTANCE) return projected;
    const ex = node.maxX - node.minX;
    const ey = node.maxY - node.minY;
    const ez = node.maxZ - node.minZ;
    const footprint = ex * ez;
    if (footprint <= 0) return projected;
    const ratio = (Math.abs(dy) * footprint + (Math.abs(dx) * ez + Math.abs(dz) * ex) * ey) / (distance * footprint);
    return projected * Math.sqrt(ratio >= 1 ? 1 : ratio <= MIN_FORESHORTENING ? MIN_FORESHORTENING : ratio);
  }

  /**
   * Choisit les nœuds à dessiner pour cette caméra.
   * @param projScaleY `proj[1][1]` de la projection (focale), voir `screenSpaceSize`.
   */
  update(viewProj: Float32Array, projScaleY: number, camX: number, camY: number, camZ: number, viewportH: number): void {
    if (this.destroyed) return;
    const frame = ++this.frameIndex;
    const previousFrame = frame - 1;
    const focalPx = Math.abs(projScaleY) * viewportH * 0.5;
    const planes = extractFrustumPlanes(viewProj);
    const heap = this.heap;
    const nodes = this.nodes;
    this.frustumCulled = 0;
    this.pending.clear();
    heap.clear();

    // Les racines des tuiles visibles passent d'abord et tiennent toujours :
    // quels que soient l'angle et le budget, chaque tuile à l'écran montre au
    // moins son niveau le plus grossier.
    for (const rootId of this.roots) {
      const root = nodes[rootId]!;
      if (frustumTestAABB(planes, root) === OUTSIDE) {
        this.frustumCulled++;
        continue;
      }
      this.evaluate(root, camX, camY, camZ, focalPx);
      heap.push(rootId, Infinity);
    }

    const selected = this.selected;
    selected.length = 0;
    const budget = this.pointBudget;
    let charged = 0;
    while (heap.size > 0) {
      const id = heap.pop();
      const node = nodes[id]!;
      if (node.state === 'failed') continue;
      // Dessiné seulement sous un parent dessiné : l'écran se remplit toujours du grossier au fin.
      const parentCovered = node.parent < 0 || nodes[node.parent]!.coveredFrame === frame;
      const count = node.entry.count;
      if (count > 0) {
        const limit = node.lastSelectedFrame === previousFrame ? budget : budget * NEW_NODE_BUDGET_SHARE;
        if (node.parent >= 0 && charged + count > limit) continue;
        charged += count;
        node.lastSelectedFrame = frame;
        if (node.state === 'resident' && parentCovered) {
          selected.push(node);
          node.lastDrawnFrame = frame;
          node.coveredFrame = frame;
        } else if (node.state === 'idle') {
          this.pending.set(id, heap.topKey);
          this.pendingRank[id] = heap.topKey;
        }
      } else {
        node.lastSelectedFrame = frame;
        if (parentCovered) node.coveredFrame = frame;
      }
      // Hystérésis : un nœud raffiné le reste jusqu'à ce que son espacement soit nettement assez fin.
      const threshold = node.refinedFrame === previousFrame ? TARGET_SPACING_PX * UNREFINE_FACTOR : TARGET_SPACING_PX;
      if (node.projectedSpacing <= threshold) continue;
      node.refinedFrame = frame;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        if (frustumTestAABB(planes, child) === OUTSIDE) {
          this.frustumCulled++;
          continue;
        }
        const rank = this.evaluate(child, camX, camY, camZ, focalPx);
        heap.push(childId, child.lastSelectedFrame === previousFrame ? rank * KEEP_PRIORITY_BOOST : rank);
      }
    }
    this.targetPoints = charged;

    // Octants couverts par un enfant dessiné (ou par un enfant vide raffiné
    // plus loin) : les points propres du nœud n'y sont pas les plus fins à l'écran.
    for (const node of selected) {
      let mask = 0;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        const covered = child.entry.count > 0
          ? child.lastDrawnFrame === frame
          : child.coveredFrame === frame && child.refinedFrame === frame;
        if (covered) mask |= 1 << octantOf(child.entry);
      }
      node.childMask = mask;
    }

    // De l'avant vers l'arrière : les sprites opaques rejettent alors tôt les fragments cachés.
    selected.sort((a, b) => a.viewDistance - b.viewDistance);
    this.pumpLoads();
  }

  /**
   * Nœuds résidents qui projettent une ombre dans un frustum de lumière (mode
   * photo), du grossier au fin : un nœud est gardé tant que `maxPoints` le
   * permet et raffiné tant que sa cellule dépasse `texelM` (les niveaux plus
   * fins n'apportent rien que la carte d'ombres puisse montrer). Seuls les
   * enfants des nœuds gardés sont visités (un niveau de l'octree additif est
   * incomplet sans ses ancêtres) et rien n'est chargé : les projeteurs hors
   * de l'écran sont les niveaux grossiers gardés résidents. Fixe le
   * `shadowChildMask` des nœuds gardés, comme `childMask` pour la caméra.
   * Renvoie le nombre de points gardés.
   */
  selectShadowCasters(planes: FrustumPlanes, texelM: number, maxPoints: number, out: SceneNode[]): number {
    out.length = 0;
    const nodes = this.nodes;
    const token = ++this.shadowToken;
    const queue = this.shadowQueue;
    queue.length = 0;
    for (const rootId of this.roots) {
      const root = nodes[rootId]!;
      if (root.state === 'resident' && frustumTestAABB(planes, root) !== OUTSIDE) queue.push(rootId);
    }
    let points = 0;
    for (let head = 0; head < queue.length; head++) {
      const node = nodes[queue[head]!]!;
      const count = node.entry.count;
      if (count > 0) {
        if (points + count > maxPoints) continue;
        points += count;
        out.push(node);
      }
      node.shadowMark = token;
      if (node.cell <= texelM) continue;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        if (child.state === 'resident' && frustumTestAABB(planes, child) !== OUTSIDE) queue.push(childId);
      }
    }
    for (const node of out) {
      let mask = 0;
      for (const childId of node.children) {
        const child = nodes[childId]!;
        if (child.shadowMark === token) mask |= 1 << octantOf(child.entry);
      }
      node.shadowChildMask = mask;
    }
    return points;
  }

  private pumpLoads(): void {
    if (this.inFlight >= MAX_CONCURRENT_LOADS || this.pending.size === 0) return;
    this.evictionQueue = null;
    // Rang le plus haut d'abord ; le tas sort déjà le plus souvent dans cet
    // ordre, ce dont le tri tire parti.
    const queue = this.loadQueue;
    const rank = this.pendingRank;
    queue.length = 0;
    for (const id of this.pending.keys()) queue.push(id);
    queue.sort((a, b) => rank[b]! - rank[a]!);
    for (const id of queue) {
      if (this.inFlight >= MAX_CONCURRENT_LOADS) break;
      const node = this.nodes[id]!;
      if (node.state !== 'idle') {
        this.pending.delete(id);
        continue;
      }
      // Du grossier au fin : un nœud attend les points de son parent, qui resserrent ses bornes.
      const parent = node.parent >= 0 ? this.nodes[node.parent]! : null;
      if (parent && parent.entry.count > 0 && parent.state !== 'resident') continue;
      if (!this.makeRoom(node.entry.count)) break;
      this.pending.delete(id);
      this.startLoad(node);
    }
  }

  private fits(points: number): boolean {
    return this.residentPoints + this.reservedPoints + points <= this.poolBudget
      && this.residentNodes + this.reservedNodes < this.maxResidentNodes;
  }

  /** Évince les nœuds sélectionnés le moins récemment jusqu'à ce qu'un nœud de plus de `points` tienne dans le pool. */
  private makeRoom(points: number): boolean {
    if (this.fits(points)) return true;
    if (!this.evictionQueue) {
      const frame = this.frameIndex;
      this.evictionQueue = this.nodes
        .filter((node) => node.state === 'resident' && !node.virtual && node.depth > 0 && node.lastSelectedFrame < frame)
        .sort((a, b) => a.lastSelectedFrame - b.lastSelectedFrame || b.depth - a.depth);
      this.evictionCursor = 0;
    }
    const queue = this.evictionQueue;
    while (!this.fits(points) && this.evictionCursor < queue.length) {
      const node = queue[this.evictionCursor++]!;
      if (node.state === 'resident' && node.lastSelectedFrame < this.frameIndex) this.evict(node);
    }
    return this.fits(points);
  }

  private evict(node: SceneNode): void {
    this.uploader.releaseNode(node);
    node.state = 'idle';
    this.residentPoints -= node.entry.count;
    this.residentNodes--;
  }

  /** Resserre les bornes de `node` et de son sous-arbre sur les points du nœud (plus la marge). */
  private tightenToContent(node: SceneNode, block: ArrayBuffer): void {
    const count = node.entry.count;
    const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
    const step = LOD_POINT_STRIDE >> 1;
    let minQx = 65535, minQy = 65535, minQz = 65535;
    let maxQx = 0, maxQy = 0, maxQz = 0;
    for (let i = 0, end = count * step; i < end; i += step) {
      const qx = words[i]!, qy = words[i + 1]!, qz = words[i + 2]!;
      if (qx < minQx) minQx = qx;
      if (qx > maxQx) maxQx = qx;
      if (qy < minQy) minQy = qy;
      if (qy > maxQy) maxQy = qy;
      if (qz < minQz) minQz = qz;
      if (qz > maxQz) maxQz = qz;
    }
    const s = node.size / 65535;
    const margin = CONTENT_MARGIN_CELLS * node.cell;
    // Quantized CRS axes (east, north, up) → render frame (east, up, −north).
    const box: Box = {
      minX: node.originX + minQx * s - margin,
      maxX: node.originX + maxQx * s + margin,
      minY: node.originY + minQz * s - margin,
      maxY: node.originY + maxQz * s + margin,
      minZ: node.originZ - maxQy * s - margin,
      maxZ: node.originZ - minQy * s + margin,
    };
    if (!clipNode(node, box)) return;
    // Tout descendant se trouve aussi dans les nouvelles bornes du nœud.
    const stack = [...node.children];
    while (stack.length > 0) {
      const child = this.nodes[stack.pop()!]!;
      if (clipNode(child, node)) stack.push(...child.children);
    }
  }

  private startLoad(node: SceneNode): void {
    node.state = 'loading';
    this.inFlight++;
    this.reservedPoints += node.entry.count;
    this.reservedNodes++;
    const tile = this.tiles[node.tileIndex]!;
    readLodNodeBlock(tile, node.entry)
      .then((block) => {
        if (this.destroyed || node.state !== 'loading') return;
        if (block.byteLength >= node.entry.count * LOD_POINT_STRIDE) this.tightenToContent(node, block);
        if (this.uploader.uploadNode(node, block)) {
          node.state = 'resident';
          this.residentPoints += node.entry.count;
          this.residentNodes++;
          this.uploadedNodes++;
          // Ses enfants ont été mis en file avec des bornes plus lâches : la
          // prochaine mise à jour les reclasse avant qu'aucun d'eux ne soit lu.
          for (const childId of node.children) this.pending.delete(childId);
        } else {
          node.state = 'failed';
        }
      })
      .catch((error) => {
        console.warn('[LiDAR LOD] Node read failed:', error);
        if (node.state === 'loading') node.state = 'failed';
      })
      .finally(() => {
        this.inFlight--;
        this.reservedPoints -= node.entry.count;
        this.reservedNodes--;
        if (this.destroyed) return;
        this.onNodeResident();
        this.pumpLoads();
      });
  }

  destroy(): void {
    this.destroyed = true;
    for (const node of this.nodes) {
      if (node.state === 'resident' && !node.virtual) this.uploader.releaseNode(node);
    }
    this.selected = [];
    this.pending.clear();
  }
}
