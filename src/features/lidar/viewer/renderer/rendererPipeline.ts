import { LOD_POINT_STRIDE } from '../lod/lodTile';
import {
  BLIT_SHADER,
  EDL_SHADER,
  EDL_SHADER_MSAA,
  NODE_UNIFORM_BYTES,
  POINT_SHADER,
  PRESENT_SHADER,
  POINT_SHADING_SHADER,
  ROUTE_SHADER,
  SUN_DISC_SHADER,
  TERRAIN_SHADER,
  TRAJECTORY_SHADER,
} from './shaders';

/** Z inversé (effacé à 0, `greater`) : la profondeur flottante garde sa précision à toute distance. */
export const SCENE_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** Moyenne courante des images fixes (lumière linéaire), voir RestRefinement. */
export const ACCUMULATION_FORMAT: GPUTextureFormat = 'rgba16float';

export interface RendererPipelines {
  pointPipeline: GPURenderPipeline;
  /** Mêmes sprites en carrés simples (sans discard), dessinés pendant que la caméra bouge. */
  pointPipelineSquare: GPURenderPipeline;
  /** Terrain par chunks (TerrainLod) : groupe 1 = recul par chunk. */
  terrainLodPipeline: GPURenderPipeline;
  previewPipeline: GPURenderPipeline;
  trajectoryPipeline: GPURenderPipeline;
  sunDiscPipeline: GPURenderPipeline;
  routePipeline: GPURenderPipeline;
  edlPipeline: GPURenderPipeline;
  /** Agrandit une scène rendue sous la résolution du canvas. */
  blitPipeline: GPURenderPipeline;
  /** EDL (ou copie simple) d'une image fixe mélangée dans la cible d'accumulation (constante de mélange = poids). */
  accumulatePipeline: GPURenderPipeline;
  /** Cible d'accumulation → canvas. */
  presentPipeline: GPURenderPipeline;
  shadingPipeline: GPUComputePipeline;
  sceneBindGroupLayout: GPUBindGroupLayout;
  pointParamsBindGroupLayout: GPUBindGroupLayout;
  /** Groupe 2 du pipeline des points : uniform par nœud, décalage dynamique. */
  nodeBindGroupLayout: GPUBindGroupLayout;
  /** Groupe 1 du pipeline du terrain : recul par chunk. */
  terrainLodBindGroupLayout: GPUBindGroupLayout;
  shadingBindGroupLayout: GPUBindGroupLayout;
  edlBindGroupLayout: GPUBindGroupLayout;
  blitBindGroupLayout: GPUBindGroupLayout;
  presentBindGroupLayout: GPUBindGroupLayout;
}

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

/**
 * Biais de profondeur proportionnel à la pente pour le maillage du terrain
 * (Z inversé : négatif le repousse). Le maillage est un modèle de sol lissé situé
 * quelques centimètres au-dessus de certains retours sol ; vu en incidence
 * rasante (vue à hauteur d'œil, orbite basse), il les cacherait. Repoussé là
 * où le triangle est pentu en profondeur, il ne fait que boucher les trous
 * entre les points, comme voulu.
 */
const TERRAIN_DEPTH_SLOPE_BIAS = -4;

type SharedLayouts = Pick<
  RendererPipelines,
  'sceneBindGroupLayout' | 'pointParamsBindGroupLayout' | 'nodeBindGroupLayout' | 'shadingBindGroupLayout' | 'terrainLodBindGroupLayout'
>;

/**
 * @param reuse layouts d'un jeu précédent (par ex. quand le MSAA est coupé
 *   à l'exécution) pour que les bind groups créés avec eux restent valides.
 */
export async function createRendererPipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  reuse?: SharedLayouts,
): Promise<RendererPipelines> {
  // Lu ici, jamais au niveau du module : les navigateurs sans WebGPU (Firefox
  // sous Linux) n'ont pas `GPUShaderStage`, et l'évaluer à l'import cassait
  // tout le viewer là-bas, WebGL 2 compris.
  const ALL_STAGES = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
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
      // Masques d'enfants de chaque emplacement du pool (taille de point adaptative).
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
      // Masques d'enfants de chaque emplacement du pool (couleurs filtrées là où aucun enfant n'est dessiné).
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  const terrainLodBindGroupLayout = reuse?.terrainLodBindGroupLayout ?? device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
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

  const presentBindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }],
  });

  const sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout] });
  const multisample: GPUMultisampleState = { count: sampleCount };

  device.pushErrorScope('validation');

  const pointShader = device.createShaderModule({ code: POINT_SHADER });
  // Sprites opaques : pas de mélange, donc pas de halo de bords semi-transparents
  // qui écrivent la profondeur par-dessus les points derrière eux (non triés).
  // Avec le MSAA, le bord doux passe par l'alpha-to-coverage, qui reste indépendant de l'ordre.
  const pointDescriptor: GPURenderPipelineDescriptor = {
    layout: device.createPipelineLayout({
      bindGroupLayouts: [sceneBindGroupLayout, pointParamsBindGroupLayout, nodeBindGroupLayout],
    }),
    vertex: {
      module: pointShader,
      entryPoint: 'vs_main',
      buffers: [
        // Enregistrement empaqueté : position quantifiée u16×3 (+ classe|intensité), voir lodTile.ts.
        { arrayStride: LOD_POINT_STRIDE, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
        // Couleur pré-ombrée écrite par la passe d'ombrage.
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
  const terrainLodPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindGroupLayout, terrainLodBindGroupLayout] }),
    vertex: { module: terrainShader, entryPoint: 'terrain_lod_vs', buffers: TERRAIN_VERTEX_BUFFERS },
    fragment: { module: terrainShader, entryPoint: 'terrain_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { ...depthState('greater', true), depthBiasSlopeScale: TERRAIN_DEPTH_SLOPE_BIAS },
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

  const accumulatePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [edlBindGroupLayout] }),
    vertex: { module: edlShader, entryPoint: 'edl_vs', buffers: [] },
    fragment: {
      module: edlShader,
      entryPoint: 'edl_accumulate_fs',
      targets: [{
        format: ACCUMULATION_FORMAT,
        blend: {
          color: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
          alpha: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const presentShader = device.createShaderModule({ code: PRESENT_SHADER });
  const presentPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [presentBindGroupLayout] }),
    vertex: { module: presentShader, entryPoint: 'present_vs', buffers: [] },
    fragment: { module: presentShader, entryPoint: 'present_fs', targets: [{ format }] },
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
    terrainLodPipeline,
    previewPipeline,
    trajectoryPipeline,
    sunDiscPipeline,
    routePipeline,
    edlPipeline,
    blitPipeline,
    accumulatePipeline,
    presentPipeline,
    shadingPipeline,
    sceneBindGroupLayout,
    pointParamsBindGroupLayout,
    nodeBindGroupLayout,
    shadingBindGroupLayout,
    terrainLodBindGroupLayout,
    edlBindGroupLayout,
    blitBindGroupLayout,
    presentBindGroupLayout,
  };
}
