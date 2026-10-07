// ============================================
// Photo mode — sun shadow maps and surface model of the point cloud
// ============================================
//
// Three depth maps drawn from the same casters (resident LOD nodes + DTM
// mesh): cascade 0 over the whole scene, cascade 1 around what the camera
// looks at, and the surface model (DSM), a "shadow map" from the zenith that
// two compute passes turn into heights, normals and the sky view factor.
// They are world-space and only redrawn when the sun, the focus or the
// resident nodes change (see PhotoRenderer).

import type { SceneNode } from '../../lod/sceneLod';
import { extractFrustumPlanes } from '../../lod/frustum';
import { LOD_POINT_STRIDE } from '../../lod/lodTile';
import type { NodeGpuPool } from '../../renderer/nodePool';
import type { TerrainLod } from '../../renderer/terrainLod';
import { lightFrame, type LightProjection, type Vec3 } from '../lib/shadowFit';
import { invertMat4 } from '../lib/mat4';
import { bindGroup, bindGroupLayout, buffer } from './gpuLayouts';
import type { PhotoCasterSource } from './types';
import {
  DSM_HEIGHT_SHADER,
  DSM_PARAMS_BYTES,
  DSM_SHADE_SHADER,
  SHADOW_PARAMS_BYTES,
  SHADOW_SHADER,
} from './shaders/shadowShaders';

const SHADOW_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** Index of each depth map (also its shadow-mask buffer in the node pool). */
export const SHADOW_MAP = { cascade0: 0, cascade1: 1, dsm: 2 } as const;
/** Horizon search reach of the sky view factor (m). */
const SVF_REACH_M = 60;

export interface ShadowMapState {
  matrix: Float32Array;
  texelM: number;
  depthRangeM: number;
  valid: boolean;
}

export interface ShadowDrawOptions {
  source: PhotoCasterSource;
  maxPoints: number;
  /** Smallest caster sprite (m): the points' world size. */
  pointSizeM: number;
  terrain: TerrainLod | null;
  filterEnabled: boolean;
  filterMask: readonly [number, number, number, number];
}

export class PhotoShadows {
  readonly maps: GPUTexture[];
  readonly states: ShadowMapState[];
  readonly dsmHeight: GPUTexture;
  readonly dsmInfo: GPUTexture;
  /** Casters of the last draw of each map (points). */
  readonly casterPoints = [0, 0, 0];
  private readonly device: GPUDevice;
  private readonly nodePool: NodeGpuPool;
  private readonly params: GPUBuffer[];
  private readonly groups: GPUBindGroup[];
  private readonly pointPipeline: GPURenderPipeline;
  private readonly terrainPipeline: GPURenderPipeline;
  private readonly dsmParams: GPUBuffer;
  private readonly dsmHeightLayout: GPUBindGroupLayout;
  private readonly dsmHeightPipeline: GPUComputePipeline;
  private readonly dsmShadePipeline: GPUComputePipeline;
  private readonly dsmShadeGroup: GPUBindGroup;
  private dsmHeightGroup: GPUBindGroup | null = null;
  private dsmHeightDtm: GPUTexture | null = null;
  private readonly casters: SceneNode[][] = [[], [], []];
  private readonly paramData = new ArrayBuffer(SHADOW_PARAMS_BYTES);
  private readonly paramF32 = new Float32Array(this.paramData);
  private readonly paramU32 = new Uint32Array(this.paramData);

  constructor(device: GPUDevice, nodeLayout: GPUBindGroupLayout, nodePool: NodeGpuPool, resolutions: readonly [number, number, number]) {
    this.device = device;
    this.nodePool = nodePool;
    this.maps = resolutions.map((size) => device.createTexture({
      size: [size, size],
      format: SHADOW_DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.states = resolutions.map(() => ({ matrix: new Float32Array(16), texelM: 1, depthRangeM: 1, valid: false }));
    const dsmSize = resolutions[SHADOW_MAP.dsm];
    this.dsmHeight = device.createTexture({
      size: [dsmSize, dsmSize], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dsmInfo = device.createTexture({
      size: [dsmSize, dsmSize], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    const V = GPUShaderStage.VERTEX;
    const shadowLayout = bindGroupLayout(device, V, [{ uniform: true }, { storage: 'read-only-storage' }]);
    this.params = resolutions.map(() => device.createBuffer({ size: SHADOW_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.groups = this.params.map((params, index) => bindGroup(device, shadowLayout, [buffer(params), buffer(nodePool.shadowMaskBuffer(index))]));
    const module = device.createShaderModule({ code: SHADOW_SHADER });
    const depthStencil = (slopeBias: number): GPUDepthStencilState => ({
      format: SHADOW_DEPTH_FORMAT, depthCompare: 'less', depthWriteEnabled: true, depthBiasSlopeScale: slopeBias,
    });
    this.pointPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [shadowLayout, nodeLayout] }),
      vertex: {
        module,
        entryPoint: 'shadow_points_vs',
        buffers: [{ arrayStride: LOD_POINT_STRIDE, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] }],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: depthStencil(0),
    });
    this.terrainPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [shadowLayout] }),
      vertex: {
        module,
        entryPoint: 'shadow_terrain_vs',
        buffers: [{ arrayStride: 24, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(1.5),
    });

    const C = GPUShaderStage.COMPUTE;
    this.dsmParams = device.createBuffer({ size: DSM_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dsmHeightLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'depth' }, { texture: 'unfilterable-float' }, { storageTexture: 'r32float' },
    ]);
    this.dsmHeightPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dsmHeightLayout] }),
      compute: { module: device.createShaderModule({ code: DSM_HEIGHT_SHADER }), entryPoint: 'main' },
    });
    const shadeLayout = bindGroupLayout(device, C, [{ uniform: true }, { texture: 'unfilterable-float' }, { storageTexture: 'rgba8unorm' }]);
    this.dsmShadePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [shadeLayout] }),
      compute: { module: device.createShaderModule({ code: DSM_SHADE_SHADER }), entryPoint: 'main' },
    });
    this.dsmShadeGroup = bindGroup(device, shadeLayout, [buffer(this.dsmParams), this.dsmHeight.createView(), this.dsmInfo.createView()]);
  }

  /** Draws depth map `index` from the light `toLight` with projection `proj`. */
  draw(encoder: GPUCommandEncoder, index: number, toLight: Vec3, proj: LightProjection, options: ShadowDrawOptions): void {
    const list = this.casters[index]!;
    const planes = extractFrustumPlanes(proj.matrix);
    this.casterPoints[index] = options.source.select(planes, proj.texelM, options.maxPoints, list);
    this.nodePool.writeShadowMasks(index, list);

    const frame = lightFrame(toLight);
    const f = this.paramF32;
    f.set(proj.matrix, 0);
    f[16] = frame.right[0]; f[17] = frame.right[1]; f[18] = frame.right[2]; f[19] = 0;
    f[20] = frame.up[0]; f[21] = frame.up[1]; f[22] = frame.up[2]; f[23] = 0;
    // A texel and a half at least: no gaps between the sprites of a surface.
    f[24] = Math.max(options.pointSizeM, proj.texelM * 1.5);
    f[25] = 1.1;
    f[26] = options.filterEnabled ? 1 : 0;
    f[27] = 0;
    for (let i = 0; i < 4; i++) this.paramU32[28 + i] = options.filterMask[i]! >>> 0;
    this.device.queue.writeBuffer(this.params[index]!, 0, this.paramData);

    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.maps[index]!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(0, this.groups[index]!);
    if (options.terrain) options.terrain.drawFixedLevel(pass, this.terrainPipeline, proj.texelM * 2);
    pass.setPipeline(this.pointPipeline);
    pass.setBindGroup(0, this.groups[index]!);
    this.nodePool.drawShadow(pass, list);
    pass.end();

    const state = this.states[index]!;
    state.matrix.set(proj.matrix);
    state.texelM = proj.texelM;
    state.depthRangeM = proj.depthRangeM;
    state.valid = true;
  }

  /**
   * Turns the surface model's depth into heights (the DTM where no return
   * was drawn), then normals and the sky view factor.
   */
  finishDsm(encoder: GPUCommandEncoder, dtm: GPUTexture, dtmParams: readonly [number, number, number, number]): void {
    const state = this.states[SHADOW_MAP.dsm]!;
    if (!state.valid) return;
    if (this.dsmHeightDtm !== dtm || !this.dsmHeightGroup) {
      this.dsmHeightDtm = dtm;
      this.dsmHeightGroup = bindGroup(this.device, this.dsmHeightLayout, [
        buffer(this.dsmParams), this.maps[SHADOW_MAP.dsm]!.createView(), dtm.createView(), this.dsmHeight.createView(),
      ]);
    }
    const data = new Float32Array(DSM_PARAMS_BYTES / 4);
    invertMat4(data, state.matrix);
    data.set(dtmParams, 16);
    data[20] = state.texelM;
    data[21] = Math.max(4, Math.min(64, SVF_REACH_M / state.texelM));
    this.device.queue.writeBuffer(this.dsmParams, 0, data);
    const size = this.dsmHeight.width;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.dsmHeightPipeline);
    pass.setBindGroup(0, this.dsmHeightGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
    pass.setPipeline(this.dsmShadePipeline);
    pass.setBindGroup(0, this.dsmShadeGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
    pass.end();
  }

  invalidate(): void {
    for (const state of this.states) state.valid = false;
  }

  destroy(): void {
    for (const map of this.maps) map.destroy();
    for (const params of this.params) params.destroy();
    this.dsmHeight.destroy();
    this.dsmInfo.destroy();
    this.dsmParams.destroy();
  }
}
