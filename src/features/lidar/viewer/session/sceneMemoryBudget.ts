// ============================================
// Viewer LiDAR — budget mémoire d'un premier chargement de scène
// ============================================
//
// Une tuile vue pour la première fois passe par deux étapes : (1) lecture,
// décodage (tous les cœurs), colorisation et copie de ses points sol pour le
// relief, puis (2) construction de son octree LOD et écriture dans l'OPFS (un
// cœur). Les deux gardent les points de la tuile en mémoire. Charger les
// tuiles l'une après l'autre laissait quinze cœurs inactifs pendant l'essentiel
// d'une tuile (colorisation et LOD sont mono-thread : 133 s pour la scène de
// test de 9 tuiles, 2026-10-07), trois à la fois prenaient 7,65 Go.
// Le pipeline ci-dessous décode la tuile suivante pendant que la précédente
// construit son LOD — une tuile par étape, et seulement quand la mémoire des
// deux étapes tient dans un budget tiré de la mémoire de l'appareil ; une tuile
// seule passe toujours.

/**
 * Octets par point qu'une tuile ajoute à l'onglet dans chaque étape, mesurés
 * dans Edge sur la scène IGN LiDAR HD de 9 tuiles (2026-10-07, pic de l'onglet
 * avant la tuile ; décodage par lots, voir workers/copcDecodeWorker.ts) : 38 o
 * pendant le décodage (ses tableaux, les chunks compressés dans les workers de
 * décodage, leur mémoire WASM, les orthophotos), 36 o pendant la construction de
 * son LOD (tableaux d'entrée et enregistrements empaquetés de 16 o) — 38 o
 * retenus pour les deux.
 */
export const DECODE_BYTES_PER_POINT = 38;
export const LOD_BUILD_BYTES_PER_POINT = 38;
/** Part de la mémoire de l'appareil qu'un chargement de scène peut occuper en tuiles en cours de chargement. */
const BUDGET_SHARE_OF_DEVICE_MEMORY = 0.4;
/** `navigator.deviceMemory` plafonne à 8 Gio et manque hors de Chromium. */
const DEFAULT_DEVICE_MEMORY_GIB = 8;

/** Octets que les tuiles chargées pour la première fois peuvent occuper à la fois. */
export function getSceneMemoryBudgetBytes(deviceMemoryGiB?: number): number {
  const gib = deviceMemoryGiB !== undefined && Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0
    ? Math.min(deviceMemoryGiB, DEFAULT_DEVICE_MEMORY_GIB)
    : DEFAULT_DEVICE_MEMORY_GIB;
  return Math.floor(gib * 2 ** 30 * BUDGET_SHARE_OF_DEVICE_MEMORY);
}

/**
 * Nombre de points d'un fichier LAS/LAZ d'après son en-tête public (les 375
 * premiers octets suffisent) : le nombre 64 bits du LAS 1.4 quand il est
 * présent, sinon l'ancien nombre 32 bits ; null quand les octets ne sont pas
 * un en-tête LAS.
 */
export function readLasPointCount(header: ArrayBuffer): number | null {
  if (header.byteLength < 227) return null;
  const view = new DataView(header);
  if (view.getUint32(0, false) !== 0x4c415346) return null; // "LASF"
  const minor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  if (minor >= 4 && headerSize >= 375 && header.byteLength >= 255) {
    const count = Number(view.getBigUint64(247, true));
    if (count > 0) return count;
  }
  return view.getUint32(107, true);
}

/**
 * Pipeline à deux étapes des premiers chargements de tuiles : au plus une tuile
 * en décodage et une en construction de LOD. Une tuile entre dans l'étape de
 * décodage, dans l'ordre d'arrivée, dès que l'étape est libre et que ses octets
 * de décodage tiennent à côté de la construction de LOD en cours ; elle attend
 * ensuite l'étape de construction et échange ses octets de décodage contre ses
 * octets de construction. L'étape de construction n'attend jamais rien : le
 * pipeline ne peut pas se bloquer ; une tuile plus lourde que le budget passe seule.
 */
export class TileLoadPipeline {
  private readonly budgetBytes: number;
  private heldBytes = 0;
  /** L'étape de décodage est prise de l'admission jusqu'à l'entrée de la tuile dans l'étape de construction. */
  private decodeBusy = false;
  private buildBusy = false;
  private readonly waitingDecode: Array<{ bytes: number; start: () => void }> = [];
  private waitingBuild: (() => void) | null = null;

  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  /** Octets occupés par les tuiles dans le pipeline (pour les tests et le diagnostic). */
  get held(): number {
    return this.heldBytes;
  }

  run<D, B>(points: number, decode: () => Promise<D>, build: (decoded: D) => Promise<B>): Promise<B> {
    const decodeBytes = points * DECODE_BYTES_PER_POINT;
    const buildBytes = points * LOD_BUILD_BYTES_PER_POINT;
    return new Promise<B>((resolve, reject) => {
      const enterBuild = (decoded: D) => {
        this.buildBusy = true;
        this.heldBytes += buildBytes - decodeBytes;
        this.decodeBusy = false;
        build(decoded).then(resolve, reject).finally(() => {
          this.heldBytes -= buildBytes;
          this.buildBusy = false;
          const next = this.waitingBuild;
          this.waitingBuild = null;
          if (next) next();
          else this.admit();
        });
        this.admit();
      };
      this.waitingDecode.push({
        bytes: decodeBytes,
        start: () => {
          this.decodeBusy = true;
          this.heldBytes += decodeBytes;
          decode().then(
            (decoded) => {
              if (this.buildBusy) this.waitingBuild = () => enterBuild(decoded);
              else enterBuild(decoded);
            },
            (error: unknown) => {
              this.heldBytes -= decodeBytes;
              this.decodeBusy = false;
              this.admit();
              reject(error);
            },
          );
        },
      });
      this.admit();
    });
  }

  private admit(): void {
    if (this.decodeBusy) return;
    const next = this.waitingDecode[0];
    if (!next) return;
    if (this.heldBytes > 0 && this.heldBytes + next.bytes > this.budgetBytes) return;
    this.waitingDecode.shift();
    next.start();
  }
}
