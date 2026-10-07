// ============================================
// Photo mode — cloud textures, light volume, shadow map, march and accumulation
// ============================================
//
// The up-rez noise is generated in compute when the photo mode starts (a few
// slices per frame). A new cover / type / seed / sun builds the cumulus
// spheres on the CPU (`lib/cumulusModel.ts`), then the weather map, the
// dimensional profile voxels, the light volume and the ground shadow map are
// rebuilt by slices. While the view moves, the march writes the traced pixels of a
// half-resolution buffer and the temporal pass resolves them with the
// reprojected history into one of two ping-pong buffers. Once it stops,
// `march_still` traces one phase of the full-resolution pixels into a
// compact buffer and a full-screen pass blends them into the accumulation
// (blend constant 1 / (n + 1)): the image converges in place.

import { bindGroup, bindGroupLayout, buffer } from './gpuLayouts';
import {
  CLOUD_ACCUMULATE_SHADER,
  CLOUD_MARCH_SHADER,
  CLOUD_SHADOW_SHADER,
  CLOUD_SHADOW_SIZE,
  CLOUD_TEMPORAL_SHADER,
  LIGHT_SLICES_PER_STEP,
  LIGHT_VOLUME_SHADER,
  LIGHT_VOLUME_SIZE,
  HIGH_COVER_SHADER,
  HIGH_COVER_SIZE,
  LOBE_NOISE_SHADER,
  LOBE_NOISE_SIZE,
  MAX_ANVILS,
  MODEL_SHADER,
  MODEL_SIZE,
  MODEL_SLICES_PER_STEP,
  NOISE_SLICES_PER_STEP,
  SHADOW_ROWS_PER_STEP,
  UPREZ_NOISE_SHADER,
  UPREZ_NOISE_SIZE,
  WEATHER_SHADER,
  WEATHER_SIZE,
} from './shaders/cloudShaders';
import { buildCumulusField, CUMULUS_GRID_XZ, CUMULUS_GRID_Y, MAX_CUMULUS_SPHERES, SPHERE_FLOATS } from '../lib/cumulusModel';

const SLICE_PARAMS_BYTES = 64;
const MODEL_SLICE_BYTES = MODEL_SIZE[0] * MODEL_SIZE[1];
const ACCUMULATE_BLEND: GPUBlendState = {
  color: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
  alpha: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
};

function computePipeline(device: GPUDevice, code: string, layout: GPUBindGroupLayout, entryPoint = 'main'): GPUComputePipeline {
  return device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code }), entryPoint },
  });
}

interface CloudBuffer {
  color: GPUTexture;
  depth: GPUTexture;
}

/** Weather map inputs (see `WEATHER_SHADER`). */
export interface CloudWeather {
  coverage: number;
  type: number;
  seed: number;
  cellSizeM: number;
  anvil: number;
  domainHalfM: number;
  fullRadiusM: number;
  /** Clearing kept free of cumulus on the base plane, where the scene's shadow would come from. */
  clearingX: number;
  clearingZ: number;
  clearingRadiusM: number;
  /** Towers between the subject and the sun keep out of its light: horizontal direction to the sun (unit), tangent of its altitude, layer thickness (m). */
  sunX: number;
  sunZ: number;
  sunTanAltitude: number;
  thicknessM: number;
}

export class PhotoClouds {
  readonly weather: GPUTexture;
  /** Nubis³ up-rez noise (wisps, billows). */
  readonly uprez: GPUTexture;
  /** Dome heights of the mid-scale lobes. */
  readonly lobes: GPUTexture;
  /** Patches of the altocumulus / cirrus sub-layers. */
  readonly highCover: GPUTexture;
  private readonly highCoverPipeline: GPUComputePipeline;
  private readonly highCoverGroup: GPUBindGroup;
  /** Dimensional profile voxels. */
  readonly model: GPUTexture;
  readonly lightVolume: GPUTexture;
  /** Ground shadow of the clouds on their base plane (direct, total transmission, optical depth). */
  readonly shadowMap: GPUTexture;
  private readonly device: GPUDevice;
  private readonly uniforms: GPUBuffer;
  private readonly lighting: GPUBuffer;
  private readonly repeatSampler: GPUSampler;
  private readonly linearClamp: GPUSampler;
  /** Atmosphere transmittance LUT: the sun's colour at every cloud sample. */
  private readonly transmittanceView: GPUTextureView;

  private readonly uprezPipeline: GPUComputePipeline;
  private readonly lobePipeline: GPUComputePipeline;
  private readonly weatherPipeline: GPUComputePipeline;
  private readonly modelPipeline: GPUComputePipeline;
  private readonly lightPipeline: GPUComputePipeline;
  private readonly shadowPipeline: GPUComputePipeline;
  private readonly marchHalfPipeline: GPUComputePipeline;
  private readonly marchStillPipeline: GPUComputePipeline;
  private readonly temporalPipeline: GPUComputePipeline;
  private readonly accumulatePipeline: GPURenderPipeline;
  private readonly marchLayout: GPUBindGroupLayout;
  private readonly temporalLayout: GPUBindGroupLayout;
  private readonly accumulateLayout: GPUBindGroupLayout;
  private readonly uprezParams: GPUBuffer;
  private readonly lobeParams: GPUBuffer;
  private readonly weatherParams: GPUBuffer;
  private readonly modelParams: GPUBuffer;
  private readonly lightParams: GPUBuffer;
  private readonly shadowParams: GPUBuffer;
  private readonly anvilBuffer: GPUBuffer;
  private readonly sphereBuffer: GPUBuffer;
  private readonly cellBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  /** Profile words of a few slices, copied into the model texture. */
  private readonly modelStaging: GPUBuffer;
  private readonly modelLayout: GPUBindGroupLayout;
  private modelGroup: GPUBindGroup;
  private readonly uprezGroup: GPUBindGroup;
  private readonly lobeGroup: GPUBindGroup;
  private readonly weatherGroup: GPUBindGroup;
  private readonly lightGroup: GPUBindGroup;
  private readonly shadowGroup: GPUBindGroup;

  private uprezSlice = 0;
  private lobeSlice = 0;
  private weatherDirty = true;
  private modelSlice = 0;
  private lightSlice = 0;
  private shadowRow = 0;
  private builtOnce = false;
  private weatherKey = '';
  private shadowKey = '';
  /** Bumped each time the tables are complete again: the still image restarts. */
  private tableVersion = 0;

  private fresh: CloudBuffer | null = null;
  private history: [CloudBuffer, CloudBuffer] | null = null;
  private current = 0;
  private width = 0;
  private height = 0;
  private marchDepthView: GPUTextureView | null = null;
  private marchHalfGroup: GPUBindGroup | null = null;
  private temporalGroups: GPUBindGroup[] = [];

  /** Full-resolution still accumulation and the compact buffer of one phase. */
  private stillColorTex: GPUTexture | null = null;
  private stillDistTex: GPUTexture | null = null;
  private stillFresh: CloudBuffer | null = null;
  private stillWidth = 0;
  private stillHeight = 0;
  private stillInterleave = 0;
  private marchStillGroup: GPUBindGroup | null = null;
  private accumulateGroup: GPUBindGroup | null = null;

  constructor(device: GPUDevice, uniforms: GPUBuffer, lighting: GPUBuffer, linearClamp: GPUSampler, transmittance: GPUTexture) {
    this.device = device;
    this.transmittanceView = transmittance.createView();
    this.uniforms = uniforms;
    this.lighting = lighting;
    this.linearClamp = linearClamp;
    const C = GPUShaderStage.COMPUTE;
    const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.uprez = device.createTexture({
      size: [UPREZ_NOISE_SIZE, UPREZ_NOISE_SIZE, UPREZ_NOISE_SIZE], dimension: '3d', format: 'rgba8unorm', usage: storageUsage,
    });
    this.lobes = device.createTexture({
      size: [LOBE_NOISE_SIZE, LOBE_NOISE_SIZE, LOBE_NOISE_SIZE], dimension: '3d', format: 'rgba8unorm', usage: storageUsage,
    });
    this.highCover = device.createTexture({ size: [HIGH_COVER_SIZE, HIGH_COVER_SIZE], format: 'rgba8unorm', usage: storageUsage });
    this.model = device.createTexture({
      size: MODEL_SIZE, dimension: '3d', format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.weather = device.createTexture({ size: [WEATHER_SIZE, WEATHER_SIZE], format: 'rgba8unorm', usage: storageUsage });
    this.lightVolume = device.createTexture({ size: LIGHT_VOLUME_SIZE, dimension: '3d', format: 'rgba8unorm', usage: storageUsage });
    this.shadowMap = device.createTexture({ size: [CLOUD_SHADOW_SIZE, CLOUD_SHADOW_SIZE], format: 'rgba16float', usage: storageUsage });
    this.repeatSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
    });

    const sliceBuffer = () => device.createBuffer({ size: SLICE_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uprezParams = sliceBuffer();
    this.lobeParams = sliceBuffer();
    this.weatherParams = sliceBuffer();
    this.modelParams = sliceBuffer();
    this.lightParams = sliceBuffer();
    this.shadowParams = sliceBuffer();
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.anvilBuffer = device.createBuffer({ size: MAX_ANVILS * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sphereBuffer = device.createBuffer({ size: MAX_CUMULUS_SPHERES * SPHERE_FLOATS * 4, usage: storage });
    this.cellBuffer = device.createBuffer({ size: CUMULUS_GRID_XZ * CUMULUS_GRID_XZ * CUMULUS_GRID_Y * 8, usage: storage });
    this.indexBuffer = device.createBuffer({ size: 4, usage: storage });
    this.modelStaging = device.createBuffer({ size: MODEL_SLICE_BYTES * MODEL_SLICES_PER_STEP, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const noiseLayout = bindGroupLayout(device, C, [{ uniform: true }, { storageTexture: 'rgba8unorm', dimension: '3d' }]);
    this.uprezPipeline = computePipeline(device, UPREZ_NOISE_SHADER, noiseLayout);
    this.uprezGroup = bindGroup(device, noiseLayout, [buffer(this.uprezParams), this.uprez.createView({ dimension: '3d' })]);
    this.lobePipeline = computePipeline(device, LOBE_NOISE_SHADER, noiseLayout);
    this.lobeGroup = bindGroup(device, noiseLayout, [buffer(this.lobeParams), this.lobes.createView({ dimension: '3d' })]);

    const weatherLayout = bindGroupLayout(device, C, [{ uniform: true }, { storageTexture: 'rgba8unorm' }, { uniform: true }]);
    this.weatherPipeline = computePipeline(device, WEATHER_SHADER, weatherLayout);
    this.weatherGroup = bindGroup(device, weatherLayout, [buffer(this.weatherParams), this.weather.createView(), buffer(this.anvilBuffer)]);
    const coverLayout = bindGroupLayout(device, C, [{ uniform: true }, { storageTexture: 'rgba8unorm' }]);
    this.highCoverPipeline = computePipeline(device, HIGH_COVER_SHADER, coverLayout);
    this.highCoverGroup = bindGroup(device, coverLayout, [buffer(uniforms), this.highCover.createView()]);

    this.modelLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { sampler: 'filtering' }, { storage: 'read-only-storage' },
      { storage: 'read-only-storage' }, { storage: 'read-only-storage' }, { storage: 'storage' },
    ]);
    this.modelPipeline = computePipeline(device, MODEL_SHADER, this.modelLayout);
    this.modelGroup = this.makeModelGroup();

    const fieldEntries = (output: { storageTexture: GPUTextureFormat; dimension?: GPUTextureViewDimension }) => bindGroupLayout(device, C, [
      { uniform: true }, { uniform: true }, { texture: 'float' }, { texture: 'float', dimension: '3d' },
      { texture: 'float', dimension: '3d' }, { sampler: 'filtering' }, { sampler: 'filtering' }, output,
      { texture: 'float', dimension: '3d' },
    ]);
    const lightLayout = fieldEntries({ storageTexture: 'rgba8unorm', dimension: '3d' });
    this.lightPipeline = computePipeline(device, LIGHT_VOLUME_SHADER, lightLayout);
    this.lightGroup = bindGroup(device, lightLayout, [
      buffer(uniforms), buffer(this.lightParams), this.weather.createView(), this.model.createView({ dimension: '3d' }),
      this.uprez.createView({ dimension: '3d' }), this.repeatSampler, linearClamp, this.lightVolume.createView({ dimension: '3d' }),
      this.lobes.createView({ dimension: '3d' }),
    ]);
    const shadowLayout = fieldEntries({ storageTexture: 'rgba16float' });
    this.shadowPipeline = computePipeline(device, CLOUD_SHADOW_SHADER, shadowLayout);
    this.shadowGroup = bindGroup(device, shadowLayout, [
      buffer(uniforms), buffer(this.shadowParams), this.weather.createView(), this.model.createView({ dimension: '3d' }),
      this.uprez.createView({ dimension: '3d' }), this.repeatSampler, linearClamp, this.shadowMap.createView(),
      this.lobes.createView({ dimension: '3d' }),
    ]);

    this.marchLayout = bindGroupLayout(device, C, [
      { uniform: true }, { storage: 'read-only-storage' }, { texture: 'float' }, { texture: 'float', dimension: '3d' },
      { texture: 'float', dimension: '3d' }, { texture: 'float', dimension: '3d' }, { sampler: 'filtering' }, { texture: 'depth' },
      { storageTexture: 'rgba16float' }, { storageTexture: 'rg32float' }, { sampler: 'filtering' },
      { texture: 'float', dimension: '3d' }, { texture: 'float' }, { texture: 'float' },
    ]);
    const marchModule = device.createShaderModule({ code: CLOUD_MARCH_SHADER });
    const marchPipeline = (entryPoint: string) => device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.marchLayout] }),
      compute: { module: marchModule, entryPoint },
    });
    this.marchHalfPipeline = marchPipeline('march_half');
    this.marchStillPipeline = marchPipeline('march_still');
    this.temporalLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { texture: 'unfilterable-float' }, { texture: 'float' },
      { texture: 'unfilterable-float' }, { sampler: 'filtering' }, { storageTexture: 'rgba16float' }, { storageTexture: 'rg32float' },
    ]);
    this.temporalPipeline = computePipeline(device, CLOUD_TEMPORAL_SHADER, this.temporalLayout);
    this.accumulateLayout = bindGroupLayout(device, GPUShaderStage.FRAGMENT, [
      { uniform: true }, { texture: 'float' }, { texture: 'unfilterable-float' },
    ]);
    const accumulateModule = device.createShaderModule({ code: CLOUD_ACCUMULATE_SHADER });
    this.accumulatePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.accumulateLayout] }),
      vertex: { module: accumulateModule, entryPoint: 'fullscreen_vs' },
      fragment: {
        module: accumulateModule,
        entryPoint: 'accumulate_fs',
        targets: [{ format: 'rgba16float', blend: ACCUMULATE_BLEND }, { format: 'r16float', blend: ACCUMULATE_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private makeModelGroup(): GPUBindGroup {
    return bindGroup(this.device, this.modelLayout, [
      buffer(this.modelParams), this.weather.createView(), this.linearClamp, buffer(this.sphereBuffer),
      buffer(this.cellBuffer), buffer(this.indexBuffer), buffer(this.modelStaging),
    ]);
  }

  /** Noise volume, weather map, model, light volume and shadow map were all built at least once. */
  get ready(): boolean {
    return this.builtOnce;
  }

  /** Something is still being built (frames needed). */
  get building(): boolean {
    return this.uprezSlice < UPREZ_NOISE_SIZE || this.lobeSlice < LOBE_NOISE_SIZE || this.weatherDirty || this.modelSlice < MODEL_SIZE[2]
      || this.lightSlice < LIGHT_VOLUME_SIZE[2] || this.shadowRow < CLOUD_SHADOW_SIZE;
  }

  /** Changes whenever a rebuild completes: what was accumulated is stale. */
  get version(): number {
    return this.tableVersion;
  }

  /** New cover / type / seed / cell size / anvil: the weather map, the light volume and the shadow map are rebuilt. */
  setWeather(weather: CloudWeather): void {
    const key = [
      weather.coverage.toFixed(3), weather.type.toFixed(3), weather.seed, weather.cellSizeM, weather.anvil,
      weather.domainHalfM, weather.fullRadiusM,
      weather.clearingX.toFixed(0), weather.clearingZ.toFixed(0), weather.clearingRadiusM.toFixed(0),
      weather.sunX.toFixed(3), weather.sunZ.toFixed(3), weather.sunTanAltitude.toFixed(3), weather.thicknessM,
    ].join('|');
    if (key === this.weatherKey) return;
    this.weatherKey = key;
    this.weatherDirty = true;
    this.modelSlice = 0;
    const field = buildCumulusField({
      coverage: weather.coverage, type: weather.type, seed: weather.seed, cellSizeM: weather.cellSizeM,
      domainHalfM: weather.domainHalfM, fullRadiusM: weather.fullRadiusM, thicknessM: weather.thicknessM,
      clearingX: weather.clearingX, clearingZ: weather.clearingZ, clearingRadiusM: weather.clearingRadiusM,
      sunX: weather.sunX, sunZ: weather.sunZ, sunTanAltitude: weather.sunTanAltitude, anvil: weather.anvil,
    });
    if (field.count > 0) this.device.queue.writeBuffer(this.sphereBuffer, 0, field.spheres, 0, field.count * SPHERE_FLOATS);
    this.device.queue.writeBuffer(this.cellBuffer, 0, field.cells);
    if (this.indexBuffer.size < field.indices.byteLength) {
      this.indexBuffer.destroy();
      this.indexBuffer = this.device.createBuffer({ size: field.indices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.modelGroup = this.makeModelGroup();
    }
    this.device.queue.writeBuffer(this.indexBuffer, 0, field.indices);
    const anvils = new Float32Array(MAX_ANVILS * 4);
    const anvilCount = Math.min(MAX_ANVILS, field.anvils.length);
    for (let i = 0; i < anvilCount; i++) {
      const a = field.anvils[i]!;
      anvils.set([a.x, a.z, a.radiusM, 0], i * 4);
    }
    this.device.queue.writeBuffer(this.anvilBuffer, 0, anvils);
    const data = new ArrayBuffer(SLICE_PARAMS_BYTES);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);
    u32[0] = 0;
    u32[1] = weather.seed;
    f32[2] = weather.coverage;
    f32[3] = weather.type;
    f32[4] = weather.cellSizeM;
    f32[5] = anvilCount;
    f32[6] = weather.domainHalfM;
    f32[7] = weather.fullRadiusM;
    f32[15] = weather.thicknessM;
    this.device.queue.writeBuffer(this.weatherParams, 0, data);
    this.modelParamsData = data;
    this.invalidateLight();
  }

  /** Slice parameters of the weather map, reused (zStart patched) by the model slices. */
  private modelParamsData = new ArrayBuffer(SLICE_PARAMS_BYTES);

  /** Area of the ground shadow map on the base plane (render frame x/z, half-size in m). */
  setShadowArea(centreX: number, centreZ: number, halfSizeM: number): void {
    const key = `${centreX.toFixed(1)}|${centreZ.toFixed(1)}|${halfSizeM.toFixed(1)}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    this.shadowRow = 0;
  }

  /** Sun or layer change: the light volume and the shadow map are rebuilt by slices. */
  invalidateLight(): void {
    this.lightSlice = 0;
    this.shadowRow = 0;
  }

  /** Ensures the half-resolution buffers and the still accumulation for a canvas size; true when they were (re)created. */
  resize(canvasWidth: number, canvasHeight: number): boolean {
    const width = Math.max(1, Math.ceil(canvasWidth / 2));
    const height = Math.max(1, Math.ceil(canvasHeight / 2));
    if (width === this.width && height === this.height && this.fresh && this.stillWidth === canvasWidth && this.stillHeight === canvasHeight) {
      return false;
    }
    this.destroyBuffers();
    this.width = width;
    this.height = height;
    this.fresh = this.makeBuffer(width, height);
    this.history = [this.makeBuffer(width, height), this.makeBuffer(width, height)];
    this.marchHalfGroup = null;
    this.marchDepthView = null;
    this.temporalGroups = [0, 1].map((target) => {
      const previous = this.history![1 - target]!;
      const output = this.history![target]!;
      return bindGroup(this.device, this.temporalLayout, [
        buffer(this.uniforms), this.fresh!.color.createView(), this.fresh!.depth.createView(), previous.color.createView(),
        previous.depth.createView(), this.linearClamp, output.color.createView(), output.depth.createView(),
      ]);
    });
    this.stillWidth = canvasWidth;
    this.stillHeight = canvasHeight;
    const target = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.stillColorTex = this.device.createTexture({ size: [canvasWidth, canvasHeight], format: 'rgba16float', usage: target });
    this.stillDistTex = this.device.createTexture({ size: [canvasWidth, canvasHeight], format: 'r16float', usage: target });
    this.stillInterleave = 0;
    return true;
  }

  private makeBuffer(width: number, height: number): CloudBuffer {
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    return {
      color: this.device.createTexture({ size: [width, height], format: 'rgba16float', usage }),
      depth: this.device.createTexture({ size: [width, height], format: 'rg32float', usage }),
    };
  }

  get size(): [number, number] {
    return [this.width, this.height];
  }

  /** Resolved half-resolution buffer of the last moving frame (read by the composite). */
  output(): CloudBuffer | null {
    return this.history ? this.history[this.current]! : null;
  }

  /** Full-resolution still accumulation: radiance + transmittance, opacity-weighted distance. */
  stillTextures(): { color: GPUTexture; dist: GPUTexture } | null {
    return this.stillColorTex && this.stillDistTex ? { color: this.stillColorTex, dist: this.stillDistTex } : null;
  }

  /** Encodes this frame's building steps (noise slices, weather, light slices, shadow rows). */
  encodeBuild(encoder: GPUCommandEncoder): void {
    if (!this.building) return;
    const pass = encoder.beginComputePass();
    let modelCopy = -1;
    if (this.uprezSlice < UPREZ_NOISE_SIZE) {
      this.device.queue.writeBuffer(this.uprezParams, 0, new Uint32Array([this.uprezSlice, 0, 0, 0]));
      pass.setPipeline(this.uprezPipeline);
      pass.setBindGroup(0, this.uprezGroup);
      pass.dispatchWorkgroups(UPREZ_NOISE_SIZE / 4, UPREZ_NOISE_SIZE / 4, NOISE_SLICES_PER_STEP / 4);
      this.uprezSlice += NOISE_SLICES_PER_STEP;
    } else if (this.lobeSlice < LOBE_NOISE_SIZE) {
      this.device.queue.writeBuffer(this.lobeParams, 0, new Uint32Array([this.lobeSlice, 0, 0, 0]));
      pass.setPipeline(this.lobePipeline);
      pass.setBindGroup(0, this.lobeGroup);
      pass.dispatchWorkgroups(LOBE_NOISE_SIZE / 4, LOBE_NOISE_SIZE / 4, (NOISE_SLICES_PER_STEP * 4) / 4);
      this.lobeSlice += NOISE_SLICES_PER_STEP * 4;
    } else if (this.weatherDirty) {
      pass.setPipeline(this.weatherPipeline);
      pass.setBindGroup(0, this.weatherGroup);
      pass.dispatchWorkgroups(WEATHER_SIZE / 8, WEATHER_SIZE / 8);
      pass.setPipeline(this.highCoverPipeline);
      pass.setBindGroup(0, this.highCoverGroup);
      pass.dispatchWorkgroups(HIGH_COVER_SIZE / 8, HIGH_COVER_SIZE / 8);
      this.weatherDirty = false;
      this.modelSlice = 0;
      this.lightSlice = 0;
      this.shadowRow = 0;
    } else if (this.modelSlice < MODEL_SIZE[2]) {
      const params = this.modelParamsData.slice(0);
      new Uint32Array(params)[0] = this.modelSlice;
      this.device.queue.writeBuffer(this.modelParams, 0, params);
      pass.setPipeline(this.modelPipeline);
      pass.setBindGroup(0, this.modelGroup);
      pass.dispatchWorkgroups(MODEL_SIZE[0] / 4 / 16, MODEL_SIZE[1] / 8, MODEL_SLICES_PER_STEP);
      modelCopy = this.modelSlice;
      this.modelSlice += MODEL_SLICES_PER_STEP;
    } else if (this.lightSlice < LIGHT_VOLUME_SIZE[2]) {
      this.device.queue.writeBuffer(this.lightParams, 0, new Uint32Array([this.lightSlice, 0, 0, 0]));
      pass.setPipeline(this.lightPipeline);
      pass.setBindGroup(0, this.lightGroup);
      pass.dispatchWorkgroups(LIGHT_VOLUME_SIZE[0] / 8, LIGHT_VOLUME_SIZE[1] / 8, LIGHT_SLICES_PER_STEP);
      this.lightSlice += LIGHT_SLICES_PER_STEP;
    } else if (this.shadowRow < CLOUD_SHADOW_SIZE) {
      this.device.queue.writeBuffer(this.shadowParams, 0, new Uint32Array([this.shadowRow, 0, 0, 0]));
      pass.setPipeline(this.shadowPipeline);
      pass.setBindGroup(0, this.shadowGroup);
      pass.dispatchWorkgroups(CLOUD_SHADOW_SIZE / 8, SHADOW_ROWS_PER_STEP / 8);
      this.shadowRow += SHADOW_ROWS_PER_STEP;
    }
    pass.end();
    if (modelCopy >= 0) {
      encoder.copyBufferToTexture(
        { buffer: this.modelStaging, bytesPerRow: MODEL_SIZE[0], rowsPerImage: MODEL_SIZE[1] },
        { texture: this.model, origin: [0, 0, modelCopy] },
        [MODEL_SIZE[0], MODEL_SIZE[1], MODEL_SLICES_PER_STEP],
      );
    }
    if (!this.building) {
      this.builtOnce = true;
      this.tableVersion++;
    }
  }

  private marchGroup(depthView: GPUTextureView, output: CloudBuffer): GPUBindGroup {
    return bindGroup(this.device, this.marchLayout, [
      buffer(this.uniforms), buffer(this.lighting), this.weather.createView(), this.model.createView({ dimension: '3d' }),
      this.uprez.createView({ dimension: '3d' }), this.lightVolume.createView({ dimension: '3d' }), this.repeatSampler, depthView,
      output.color.createView(), output.depth.createView(), this.linearClamp, this.lobes.createView({ dimension: '3d' }),
      this.transmittanceView, this.highCover.createView(),
    ]);
  }

  private ensureMarchGroups(depthView: GPUTextureView): void {
    if (this.marchDepthView === depthView) return;
    this.marchDepthView = depthView;
    this.marchHalfGroup = null;
    this.marchStillGroup = null;
  }

  /**
   * Moving view: march (traced pixels of the half-resolution buffer) then
   * temporal resolve into the next history buffer. `fullTrace`: every pixel
   * traced this frame.
   */
  encodeMoving(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView,
    fullTrace: boolean,
    timestamps: { begin?: GPUComputePassTimestampWrites; end?: GPUComputePassTimestampWrites },
  ): void {
    if (!this.fresh || !this.history) return;
    this.ensureMarchGroups(depthView);
    this.marchHalfGroup ??= this.marchGroup(depthView, this.fresh);
    this.current = 1 - this.current;
    const march = encoder.beginComputePass({ timestampWrites: timestamps.begin });
    march.setPipeline(this.marchHalfPipeline);
    march.setBindGroup(0, this.marchHalfGroup);
    const w = fullTrace ? this.width : Math.ceil(this.width / 2);
    const h = fullTrace ? this.height : Math.ceil(this.height / 2);
    march.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    march.end();
    const temporal = encoder.beginComputePass({ timestampWrites: timestamps.end });
    temporal.setPipeline(this.temporalPipeline);
    temporal.setBindGroup(0, this.temporalGroups[this.current]!);
    temporal.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    temporal.end();
  }

  /**
   * Still view: traces this frame's phase of the full-resolution pixels
   * (`interleave` pixels per block traced in turn) and blends them into the
   * accumulation with `weight` (1 / (n + 1) for their n-th sample).
   */
  encodeStill(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView,
    interleave: number,
    weight: number,
    timestamps: { begin?: GPUComputePassTimestampWrites; end?: GPURenderPassTimestampWrites },
  ): void {
    if (!this.stillColorTex || !this.stillDistTex) return;
    this.ensureMarchGroups(depthView);
    if (interleave !== this.stillInterleave || !this.stillFresh) {
      this.stillFresh?.color.destroy();
      this.stillFresh?.depth.destroy();
      const fw = interleave === 1 ? this.stillWidth : Math.ceil(this.stillWidth / 2);
      const fh = interleave === 4 ? Math.ceil(this.stillHeight / 2) : this.stillHeight;
      this.stillFresh = this.makeBuffer(fw, fh);
      this.stillInterleave = interleave;
      this.marchStillGroup = null;
      this.accumulateGroup = bindGroup(this.device, this.accumulateLayout, [
        buffer(this.uniforms), this.stillFresh.color.createView(), this.stillFresh.depth.createView(),
      ]);
    }
    this.marchStillGroup ??= this.marchGroup(depthView, this.stillFresh);
    const march = encoder.beginComputePass({ timestampWrites: timestamps.begin });
    march.setPipeline(this.marchStillPipeline);
    march.setBindGroup(0, this.marchStillGroup);
    const traced = this.stillFresh.color;
    march.dispatchWorkgroups(Math.ceil(traced.width / 8), Math.ceil(traced.height / 8));
    march.end();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.stillColorTex.createView(), loadOp: 'load', storeOp: 'store' },
        { view: this.stillDistTex.createView(), loadOp: 'load', storeOp: 'store' },
      ],
      timestampWrites: timestamps.end,
    });
    pass.setPipeline(this.accumulatePipeline);
    pass.setBindGroup(0, this.accumulateGroup!);
    pass.setBlendConstant({ r: weight, g: weight, b: weight, a: weight });
    pass.draw(3);
    pass.end();
  }

  private destroyBuffers(): void {
    for (const b of [this.fresh, this.stillFresh, ...(this.history ?? [])]) {
      b?.color.destroy();
      b?.depth.destroy();
    }
    this.stillColorTex?.destroy();
    this.stillDistTex?.destroy();
    this.fresh = null;
    this.history = null;
    this.stillFresh = null;
    this.stillColorTex = null;
    this.stillDistTex = null;
  }

  destroy(): void {
    this.destroyBuffers();
    this.uprez.destroy();
    this.lobes.destroy();
    this.highCover.destroy();
    this.model.destroy();
    this.weather.destroy();
    this.lightVolume.destroy();
    this.shadowMap.destroy();
    for (const b of [
      this.uprezParams, this.lobeParams, this.weatherParams, this.modelParams, this.lightParams, this.shadowParams, this.anvilBuffer,
      this.sphereBuffer, this.cellBuffer, this.indexBuffer, this.modelStaging,
    ]) b.destroy();
  }
}
