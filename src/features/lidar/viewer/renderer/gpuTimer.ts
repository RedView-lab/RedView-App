// ============================================
// GPU frame timing for the adaptive point budget
// ============================================
//
// The budget used to be driven by the JS encoding time of a frame (1–3 ms),
// which says nothing about GPU load: it grew to the ceiling on every GPU.
// With the optional `timestamp-query` feature, each pass of the frame writes
// its own begin/end timestamps and only the pass durations are summed: the
// gap between the offscreen scene pass and the canvas pass contains the wait
// for the swap-chain image (≈ one vsync), which is not rendering cost — timed
// as one interval it made every frame look ~20 ms and starved the budget.
// The shading compute pass (new or stale nodes) is reported apart: the point
// budget controls the draw passes, not the streaming.
// Without the feature, the latency of `queue.onSubmittedWorkDone()` is used
// as a coarse proxy (see `usesTimestamps`).

const READBACK_SLOTS = 3;
const SAMPLE_BLEND = 0.35;
/** Timed passes of a frame, in encoding order. */
export const TIMED_PASS = { shading: 0, scene: 1, edl: 2 } as const;
const TIMED_PASSES = 3;
const QUERY_COUNT = TIMED_PASSES * 2;
const QUERY_BYTES = QUERY_COUNT * 8;

/** Begin/end writes of one pass; the same shape for render and compute passes. */
export type PassTimestampWrites = GPURenderPassTimestampWrites & GPUComputePassTimestampWrites;

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
  /** Passes (bit per index) that wrote timestamps in the frame it holds. */
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

  /** True when frame cost comes from GPU timestamps (false: submit→done latency, includes presentation waits). */
  get usesTimestamps(): boolean {
    return this.querySet !== null;
  }

  /** Smoothed GPU cost of the draw passes (scene, EDL) in ms, or 0 before the first sample. */
  getFrameMs(): number {
    return this.hasSample ? this.drawMs : 0;
  }

  /** Smoothed GPU cost of the shading compute pass per frame in ms (0 without timestamps). */
  getShadeMs(): number {
    return this.hasSample ? this.shadeMs : 0;
  }

  /** Starts measuring a frame; returns false when every readback slot is still in flight. */
  beginFrame(): boolean {
    if (!this.querySet) return false;
    this.frameSlot = this.slots.find((slot) => !slot.busy) ?? null;
    if (this.frameSlot) this.frameSlot.passes = 0;
    return this.frameSlot !== null;
  }

  /** Begin/end timestamp writes for pass `passIndex` (see `TIMED_PASS`) of the measured frame. */
  passTimestamps(passIndex: number): PassTimestampWrites | undefined {
    if (!this.querySet || !this.frameSlot || passIndex < 0 || passIndex >= TIMED_PASSES) return undefined;
    this.frameSlot.passes |= 1 << passIndex;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: passIndex * 2,
      endOfPassWriteIndex: passIndex * 2 + 1,
    };
  }

  /** Records the query resolve; call after the last pass, before `finish()`. */
  encodeResolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuffer || !this.frameSlot) return;
    encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.frameSlot.buffer, 0, QUERY_BYTES);
  }

  /** Call right after `queue.submit()`. */
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
          const drawNs = passNs(TIMED_PASS.scene) + passNs(TIMED_PASS.edl);
          const shadeNs = passNs(TIMED_PASS.shading);
          slot.buffer.unmap();
          if (drawNs > 0) this.addSample(drawNs / 1e6, shadeNs / 1e6);
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

  private addSample(drawMs: number, shadeMs: number): void {
    if (!Number.isFinite(drawMs) || drawMs <= 0) return;
    if (this.hasSample) {
      this.drawMs += (drawMs - this.drawMs) * SAMPLE_BLEND;
      this.shadeMs += (shadeMs - this.shadeMs) * SAMPLE_BLEND;
    } else {
      this.drawMs = drawMs;
      this.shadeMs = shadeMs;
    }
    this.hasSample = true;
  }
}
