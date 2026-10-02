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
// Without the feature, the latency of `queue.onSubmittedWorkDone()` is used
// as a coarse proxy (see `usesTimestamps`).

const READBACK_SLOTS = 3;
const SAMPLE_BLEND = 0.35;
/** Passes timed per frame (scene, EDL/present). */
export const TIMED_PASSES = 2;
const QUERY_COUNT = TIMED_PASSES * 2;
const QUERY_BYTES = QUERY_COUNT * 8;

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
}

export class GpuFrameTimer {
  private readonly device: GPUDevice;
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private readonly slots: ReadbackSlot[] = [];
  private frameSlot: ReadbackSlot | null = null;
  private fallbackPending = false;
  private frameMs = 0;
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

  /** Smoothed GPU cost of recent frames in ms, or 0 before the first sample. */
  getFrameMs(): number {
    return this.hasSample ? this.frameMs : 0;
  }

  /** Starts measuring a frame; returns false when every readback slot is still in flight. */
  beginFrame(): boolean {
    if (!this.querySet) return false;
    this.frameSlot = this.slots.find((slot) => !slot.busy) ?? null;
    return this.frameSlot !== null;
  }

  /** Begin/end timestamp writes for pass `passIndex` (0 … TIMED_PASSES − 1) of the measured frame. */
  passTimestamps(passIndex: number): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || !this.frameSlot || passIndex < 0 || passIndex >= TIMED_PASSES) return undefined;
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
          let ns = 0;
          for (let pass = 0; pass < TIMED_PASSES; pass++) {
            const begin = stamps[pass * 2]!;
            const end = stamps[pass * 2 + 1]!;
            if (end > begin) ns += Number(end - begin);
          }
          slot.buffer.unmap();
          if (ns > 0) this.addSample(ns / 1e6);
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
      .then(() => this.addSample(performance.now() - submittedAt))
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

  private addSample(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.frameMs = this.hasSample ? this.frameMs + (ms - this.frameMs) * SAMPLE_BLEND : ms;
    this.hasSample = true;
  }
}
