import { choosePointShaderVariant } from './platform';
import { ROUTE_SHADER, SUN_DISC_SHADER, TERRAIN_SHADER, TRAJECTORY_SHADER } from './shaders';

export interface RendererPipelines {
  pointPipeline: GPURenderPipeline;
  terrainPipeline: GPURenderPipeline;
  previewPipeline: GPURenderPipeline;
  trajectoryPipeline: GPURenderPipeline;
  sunDiscPipeline: GPURenderPipeline;
  routePipeline: GPURenderPipeline;
  pointBindGroupLayout: GPUBindGroupLayout;
  terrainBindGroupLayout: GPUBindGroupLayout;
}

export async function createRendererPipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  isApple: boolean,
  hasF32Filter: boolean,
): Promise<RendererPipelines> {
  const pointBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: hasF32Filter ? 'float' : 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: hasF32Filter ? 'filtering' : 'non-filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const terrainBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ],
  });

  const { shaderCode } = choosePointShaderVariant(isApple, hasF32Filter);

  device.pushErrorScope('validation');

  const shader = device.createShaderModule({ code: shaderCode });
  const pointPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pointBindGroupLayout] }),
    vertex: {
      module: shader,
      entryPoint: 'vs_main',
      buffers: [
        { arrayStride: 12, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }] },
        { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' as GPUVertexFormat }] },
      ],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
  });

  const terrainShader = device.createShaderModule({ code: TERRAIN_SHADER });
  const terrainPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [terrainBindGroupLayout] }),
    vertex: {
      module: terrainShader,
      entryPoint: 'terrain_vs',
      buffers: [
        {
          arrayStride: 24,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
            { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
          ],
        },
        {
          arrayStride: 4,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 2, offset: 0, format: 'unorm8x4' as GPUVertexFormat },
          ],
        },
      ],
    },
    fragment: {
      module: terrainShader,
      entryPoint: 'terrain_fs',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
  });

  const previewPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [terrainBindGroupLayout] }),
    vertex: {
      module: terrainShader,
      entryPoint: 'terrain_vs',
      buffers: [
        {
          arrayStride: 24,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
            { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
          ],
        },
        {
          arrayStride: 4,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 2, offset: 0, format: 'unorm8x4' as GPUVertexFormat },
          ],
        },
      ],
    },
    fragment: {
      module: terrainShader,
      entryPoint: 'terrain_fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
  });

  const trajectoryShader = device.createShaderModule({ code: TRAJECTORY_SHADER });
  const trajectoryPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pointBindGroupLayout] }),
    vertex: {
      module: trajectoryShader,
      entryPoint: 'trajectory_vs',
      buffers: [
        {
          arrayStride: 28,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
            { shaderLocation: 1, offset: 12, format: 'float32x4' as GPUVertexFormat },
          ],
        },
      ],
    },
    fragment: {
      module: trajectoryShader,
      entryPoint: 'trajectory_fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'line-strip' },
    depthStencil: { depthWriteEnabled: false, depthCompare: 'less-equal', format: 'depth24plus' },
  });

  const sunDiscShader = device.createShaderModule({ code: SUN_DISC_SHADER });
  const sunDiscPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pointBindGroupLayout] }),
    vertex: {
      module: sunDiscShader,
      entryPoint: 'sun_disc_vs',
      buffers: [],
    },
    fragment: {
      module: sunDiscShader,
      entryPoint: 'sun_disc_fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { depthWriteEnabled: false, depthCompare: 'always', format: 'depth24plus' },
  });

  const routeShader = device.createShaderModule({ code: ROUTE_SHADER });
  const routePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pointBindGroupLayout] }),
    vertex: {
      module: routeShader,
      entryPoint: 'route_vs',
      buffers: [
        {
          arrayStride: 12,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
        },
        {
          arrayStride: 4,
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm8x4' as GPUVertexFormat }],
        },
      ],
    },
    fragment: {
      module: routeShader,
      entryPoint: 'route_fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { depthWriteEnabled: false, depthCompare: 'less-equal', format: 'depth24plus' },
  });

  const pipelineError = await device.popErrorScope();
  if (pipelineError) {
    throw new Error(`GPU pipeline creation failed: ${pipelineError.message}`);
  }

  return {
    pointPipeline,
    terrainPipeline,
    previewPipeline,
    trajectoryPipeline,
    sunDiscPipeline,
    routePipeline,
    pointBindGroupLayout,
    terrainBindGroupLayout,
  };
}
