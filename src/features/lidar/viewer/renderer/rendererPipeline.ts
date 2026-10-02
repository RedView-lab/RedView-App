import { LOD_POINT_STRIDE } from '../lod/lodTile';
import {
  BLIT_SHADER,
  EDL_SHADER,
  EDL_SHADER_MSAA,
  NODE_UNIFORM_BYTES,
  POINT_SHADER,
  POINT_SHADING_SHADER,
  ROUTE_SHADER,
  SUN_DISC_SHADER,
  TERRAIN_SHADER,
  TRAJECTORY_SHADER,
} from './shaders';

/** Reversed-Z (cleared to 0, `greater`): float depth keeps precision at every distance. */
export const SCENE_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export interface RendererPipelines {
  pointPipeline: GPURenderPipeline;
  /** Same sprites as plain squares (no discard), drawn while the camera moves. */
  pointPipelineSquare: GPURenderPipeline;
  terrainPipeline: GPURenderPipeline;
  previewPipeline: GPURenderPipeline;
  trajectoryPipeline: GPURenderPipeline;
  sunDiscPipeline: GPURenderPipeline;
  routePipeline: GPURenderPipeline;
  edlPipeline: GPURenderPipeline;
  /** Upscales a scene rendered below the canvas resolution. */
  blitPipeline: GPURenderPipeline;
  shadingPipeline: GPUComputePipeline;
  sceneBindGroupLayout: GPUBindGroupLayout;
  pointParamsBindGroupLayout: GPUBindGroupLayout;
  /** Group 2 of the point pipeline: per-node uniform, dynamic offset. */
  nodeBindGroupLayout: GPUBindGroupLayout;
  shadingBindGroupLayout: GPUBindGroupLayout;
  edlBindGroupLayout: GPUBindGroupLayout;
  blitBindGroupLayout: GPUBindGroupLayout;
}

const ALL_STAGES = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

const TERRAIN_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 24,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
    ],
  },
  { arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] },
];

function depthState(compare: GPUCompareFunction, write: boolean): GPUDepthStencilState {
  return { format: SCENE_DEPTH_FORMAT, depthCompare: compare, depthWriteEnabled: write };
}

type SharedLayouts = Pick<
  RendererPipelines,
  'sceneBindGroupLayout' | 'pointParamsBindGroupLayout' | 'nodeBindGroupLayout' | 'shadingBindGroupLayout'
>;

/**
 * @param reuse layouts of a previous set (e.g. when MSAA is switched off at
 *   runtime) so bind groups created against them stay valid.
 */
export async function createRendererPipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  reuse?: SharedLayouts,
): Promise<RendererPipelines> {
  const sceneBindGroupLayout = reuse?.sceneBindGroupLayout ?? device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: ALL_STAGES, buffer: { type: 'uniform' } },
      { binding: 1, visibility: ALL_STAGES, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: ALL_STAGES, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: ALL_STAGES, texture: { sampleType: 'float' } },
      { binding: 5, visibility: ALL_STAGES, sampler: { type: 'filtering' } },
      { binding: 6, visibility: ALL_STAGES, texture: { sampleType: 'float' } },
      { binding: 7, visibility: ALL_STAGES, sampler: { type: 'filtering' } },
      { binding: 8, visibility: ALL_STAGES, texture: { sampleType: 'unfilterable-float' } },
      { binding: 9, visibility: ALL_STAGES, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const pointParamsBindGroupLayout = reuse?.pointParamsBindGroupLayout ?? device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      // Child masks of every pool slot (adaptive point size).
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });

  const nodeBindGroupLayout = reuse?.nodeBindGroupLayout ?? device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: NODE_UNIFORM_BYTES },
      },
    ],
  });

  const shadingBindGroupLayout = reuse?.shadingBindGroupLayout ?? device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: NODE_UNIFORM_BYTES } },
    ],
  });

  const edlBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth', multisampled: sampleCount > 1 },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const blitBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout] });
  const multisample: GPUMultisampleState = { count: sampleCount };

  device.pushErrorScope('validation');

  const pointShader = device.createShaderModule({ code: POINT_SHADER });
  // Opaque sprites: no blending, so no halo of half-transparent edges that
  // write depth over the points behind them (unsorted). With MSAA the soft
  // edge goes through alpha-to-coverage, which stays order-independent.
  const pointDescriptor: GPURenderPipelineDescriptor = {
    layout: device.createPipelineLayout({
      bindGroupLayouts: [sceneBindGroupLayout, pointParamsBindGroupLayout, nodeBindGroupLayout],
    }),
    vertex: {
      module: pointShader,
      entryPoint: 'vs_main',
      buffers: [
        // Packed record: u16×3 quantized position (+ class|intensity), see lodTile.ts.
        { arrayStride: LOD_POINT_STRIDE, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
        // Pre-shaded colour written by the shading pass.
        { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' }] },
      ],
    },
    fragment: { module: pointShader, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-strip' },
    depthStencil: depthState('greater', true),
    multisample: { count: sampleCount, alphaToCoverageEnabled: sampleCount > 1 },
  };
  const pointPipeline = device.createRenderPipeline(pointDescriptor);
  const pointPipelineSquare = device.createRenderPipeline({
    ...pointDescriptor,
    fragment: { module: pointShader, entryPoint: 'fs_square', targets: [{ format }] },
  });

  const terrainShader = device.createShaderModule({ code: TERRAIN_SHADER });
  const terrainPipeline = device.createRenderPipeline({
    layout: sceneLayout,
    vertex: { module: terrainShader, entryPoint: 'terrain_vs', buffers: TERRAIN_VERTEX_BUFFERS },
    fragment: { module: terrainShader, entryPoint: 'terrain_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: depthState('greater', true),
    multisample,
  });

  const previewPipeline = device.createRenderPipeline({
    layout: sceneLayout,
    vertex: { module: terrainShader, entryPoint: 'terrain_vs', buffers: TERRAIN_VERTEX_BUFFERS },
    fragment: { module: terrainShader, entryPoint: 'terrain_fs', targets: [{ format, blend: ALPHA_BLEND }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthState('greater', true),
    multisample,
  });

  const trajectoryShader = device.createShaderModule({ code: TRAJECTORY_SHADER });
  const trajectoryPipeline = device.createRenderPipeline({
    layout: sceneLayout,
    vertex: {
      module: trajectoryShader,
      entryPoint: 'trajectory_vs',
      buffers: [{
        arrayStride: 28,
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x4' },
        ],
      }],
    },
    fragment: { module: trajectoryShader, entryPoint: 'trajectory_fs', targets: [{ format, blend: ADDITIVE_BLEND }] },
    primitive: { topology: 'line-strip' },
    depthStencil: depthState('greater-equal', false),
    multisample,
  });

  const sunDiscShader = device.createShaderModule({ code: SUN_DISC_SHADER });
  const sunDiscPipeline = device.createRenderPipeline({
    layout: sceneLayout,
    vertex: { module: sunDiscShader, entryPoint: 'sun_disc_vs', buffers: [] },
    fragment: { module: sunDiscShader, entryPoint: 'sun_disc_fs', targets: [{ format, blend: ADDITIVE_BLEND }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthState('always', false),
    multisample,
  });

  const routeShader = device.createShaderModule({ code: ROUTE_SHADER });
  const routePipeline = device.createRenderPipeline({
    layout: sceneLayout,
    vertex: {
      module: routeShader,
      entryPoint: 'route_vs',
      buffers: [
        { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' }] },
      ],
    },
    fragment: { module: routeShader, entryPoint: 'route_fs', targets: [{ format, blend: ALPHA_BLEND }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthState('greater-equal', false),
    multisample,
  });

  const edlShader = device.createShaderModule({ code: sampleCount > 1 ? EDL_SHADER_MSAA : EDL_SHADER });
  const edlPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [edlBindGroupLayout] }),
    vertex: { module: edlShader, entryPoint: 'edl_vs', buffers: [] },
    fragment: { module: edlShader, entryPoint: 'edl_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const blitShader = device.createShaderModule({ code: BLIT_SHADER });
  const blitPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [blitBindGroupLayout] }),
    vertex: { module: blitShader, entryPoint: 'blit_vs', buffers: [] },
    fragment: { module: blitShader, entryPoint: 'blit_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const shadingShader = device.createShaderModule({ code: POINT_SHADING_SHADER });
  const shadingPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout, shadingBindGroupLayout] }),
    compute: { module: shadingShader, entryPoint: 'shade_main' },
  });

  const pipelineError = await device.popErrorScope();
  if (pipelineError) {
    throw new Error(`GPU pipeline creation failed: ${pipelineError.message}`);
  }

  return {
    pointPipeline,
    pointPipelineSquare,
    terrainPipeline,
    previewPipeline,
    trajectoryPipeline,
    sunDiscPipeline,
    routePipeline,
    edlPipeline,
    blitPipeline,
    shadingPipeline,
    sceneBindGroupLayout,
    pointParamsBindGroupLayout,
    nodeBindGroupLayout,
    shadingBindGroupLayout,
    edlBindGroupLayout,
    blitBindGroupLayout,
  };
}
