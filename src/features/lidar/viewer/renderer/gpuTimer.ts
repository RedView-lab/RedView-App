// ============================================
// Chronométrage GPU des images pour le budget de points adaptatif
// ============================================
//
// Le budget était piloté par le temps d'encodage JS d'une image (1–3 ms), qui
// ne dit rien de la charge GPU : il montait au plafond sur tous les GPU.
// Avec la fonctionnalité optionnelle `timestamp-query`, chaque passe de l'image
// écrit ses propres horodatages de début/fin et seules les durées des passes
// sont additionnées : l'écart entre la passe de scène hors écran et la passe du
// canvas contient l'attente de l'image de la swap-chain (≈ une vsync), qui
// n'est pas un coût de rendu — chronométré d'un seul tenant, il faisait paraître
// chaque image à ~20 ms et affamait le budget.
// La passe de calcul d'ombrage (nœuds nouveaux ou périmés) est comptée à part :
// le budget de points pilote les passes de dessin, pas le flux.
// Sans la fonctionnalité, la latence de `queue.onSubmittedWorkDone()` sert
// d'approximation grossière (voir `usesTimestamps`).

const READBACK_SLOTS = 3;
const SAMPLE_BLEND = 0.35;
/**
 * Passes chronométrées d'une image, dans l'ordre d'encodage. Les `photo`
 * (éclairage → final) et `clouds` (marche → temporel) du mode photo sont des
 * plages couvrant plusieurs passes : début écrit par la première, fin par la dernière.
 */
export const TIMED_PASS = { shading: 0, scene: 1, edl: 2, photo: 3, clouds: 4 } as const;
const TIMED_PASSES = 5;
const QUERY_COUNT = TIMED_PASSES * 2;
const QUERY_BYTES = QUERY_COUNT * 8;

/** Écritures de début/fin d'une passe ; même forme pour les passes de rendu et de calcul. */
export type PassTimestampWrites = GPURenderPassTimestampWrites & GPUComputePassTimestampWrites;

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
  /** Passes (un bit par indice) qui ont écrit des horodatages dans l'image qu'il contient. */
  passes: number;
}

export class GpuFrameTimer {
  private readonly device: GPUDevice;
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private readonly slots: ReadbackSlot[] = [];
  private frameSlot: ReadbackSlot | null = null;
  private fallbackPending = false;
  private drawMs = 0;
  private shadeMs = 0;
  private cloudMs = 0;
  private hasSample = false;
  private destroyed = false;

  constructor(device: GPUDevice) {
    this.device = device;
    if (!device.features.has('timestamp-query')) return;
    try {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_COUNT });
      this.resolveBuffer = device.createBuffer({
        size: QUERY_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      for (let i = 0; i < READBACK_SLOTS; i++) {
        this.slots.push({
          buffer: device.createBuffer({ size: QUERY_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
          busy: false,
          passes: 0,
        });
      }
    } catch {
      this.querySet = null;
    }
  }

  /** Vrai quand le coût d'image vient des horodatages GPU (faux : latence soumission→fin, attentes de présentation comprises). */
  get usesTimestamps(): boolean {
    return this.querySet !== null;
  }

  /** Coût GPU lissé des passes de dessin (scène, EDL) en ms, ou 0 avant le premier échantillon. */
  getFrameMs(): number {
    return this.hasSample ? this.drawMs : 0;
  }

  /** Coût GPU lissé de la passe de calcul d'ombrage par image en ms (0 sans horodatages). */
  getShadeMs(): number {
    return this.hasSample ? this.shadeMs : 0;
  }

  /** Coût GPU lissé des nuages du mode photo par image en ms (compris dans `getFrameMs`). */
  getCloudMs(): number {
    return this.hasSample ? this.cloudMs : 0;
  }

  /** Commence la mesure d'une image ; renvoie false quand tous les emplacements de relecture sont encore en vol. */
  beginFrame(): boolean {
    if (!this.querySet) return false;
    this.frameSlot = this.slots.find((slot) => !slot.busy) ?? null;
    if (this.frameSlot) this.frameSlot.passes = 0;
    return this.frameSlot !== null;
  }

  /**
   * Écritures d'horodatage de la passe `passIndex` (voir `TIMED_PASS`) de
   * l'image mesurée : les deux bouts, ou seulement le `begin` / `end` d'une plage de passes.
   */
  passTimestamps(passIndex: number, part: 'both' | 'begin' | 'end' = 'both'): PassTimestampWrites | undefined {
    if (!this.querySet || !this.frameSlot || passIndex < 0 || passIndex >= TIMED_PASSES) return undefined;
    if (part !== 'begin') this.frameSlot.passes |= 1 << passIndex;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: part !== 'end' ? passIndex * 2 : undefined,
      endOfPassWriteIndex: part !== 'begin' ? passIndex * 2 + 1 : undefined,
    };
  }

  /** Enregistre la résolution des requêtes ; à appeler après la dernière passe, avant `finish()`. */
  encodeResolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuffer || !this.frameSlot) return;
    encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.frameSlot.buffer, 0, QUERY_BYTES);
  }

  /** À appeler juste après `queue.submit()`. */
  afterSubmit(): void {
    if (this.destroyed) return;
    if (this.querySet) {
      const slot = this.frameSlot;
      this.frameSlot = null;
      if (!slot) return;
      slot.busy = true;
      slot.buffer.mapAsync(GPUMapMode.READ)
        .then(() => {
          const stamps = new BigUint64Array(slot.buffer.getMappedRange());
          const passNs = (pass: number): number => {
            if ((slot.passes & (1 << pass)) === 0) return 0;
            const begin = stamps[pass * 2]!;
            const end = stamps[pass * 2 + 1]!;
            return end > begin ? Number(end - begin) : 0;
          };
          const cloudNs = passNs(TIMED_PASS.clouds);
          const drawNs = passNs(TIMED_PASS.scene) + passNs(TIMED_PASS.edl) + passNs(TIMED_PASS.photo) + cloudNs;
          const shadeNs = passNs(TIMED_PASS.shading);
          slot.buffer.unmap();
          if (drawNs > 0) this.addSample(drawNs / 1e6, shadeNs / 1e6, cloudNs / 1e6);
        })
        .catch(() => undefined)
        .finally(() => {
          slot.busy = false;
        });
      return;
    }

    if (this.fallbackPending) return;
    this.fallbackPending = true;
    const submittedAt = performance.now();
    this.device.queue.onSubmittedWorkDone()
      .then(() => this.addSample(performance.now() - submittedAt, 0))
      .catch(() => undefined)
      .finally(() => {
        this.fallbackPending = false;
      });
  }

  destroy(): void {
    this.destroyed = true;
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const slot of this.slots) slot.buffer.destroy();
    this.querySet = null;
    this.resolveBuffer = null;
  }

  private addSample(drawMs: number, shadeMs: number, cloudMs = 0): void {
    if (!Number.isFinite(drawMs) || drawMs <= 0) return;
    if (this.hasSample) {
      this.drawMs += (drawMs - this.drawMs) * SAMPLE_BLEND;
      this.shadeMs += (shadeMs - this.shadeMs) * SAMPLE_BLEND;
      this.cloudMs += (cloudMs - this.cloudMs) * SAMPLE_BLEND;
    } else {
      this.drawMs = drawMs;
      this.shadeMs = shadeMs;
      this.cloudMs = cloudMs;
    }
    this.hasSample = true;
  }
}
