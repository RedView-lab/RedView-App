// ============================================
// Standalone LiDAR HD Viewer — WebGPU Renderer
// ============================================
// Hybrid LOD: smooth disc billboards (far) + raytraced box imposters (near).
// Normals computed on GPU via Sobel gradient on heightmap texture.

const SHADER = /* wgsl */`
struct Camera {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  cameraPos: vec4<f32>,
  pointSize: f32,
  lodThreshold: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  sunDir: vec4<f32>,
  hmOriginX: f32,
  hmOriginZ: f32,
  hmScaleX: f32,
  hmScaleZ: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var heightSamp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) center: vec3<f32>,
  @location(3) localUV: vec2<f32>,
  @location(4) sobelNormal: vec3<f32>,
  @location(5) @interpolate(flat) camDist: f32,
  @location(6) @interpolate(flat) radius: f32,
};

fn computeSobelNormal(worldPos: vec3<f32>) -> vec3<f32> {
  let u = (worldPos.x - camera.hmOriginX) / camera.hmScaleX;
  let v = (worldPos.z - camera.hmOriginZ) / camera.hmScaleZ;

  let dims = vec2<f32>(textureDimensions(heightTex, 0));
  let texel = 1.0 / dims;

  let gatherL = textureGather(0, heightTex, heightSamp, vec2<f32>(u - texel.x, v));
  let gatherR = textureGather(0, heightTex, heightSamp, vec2<f32>(u + texel.x, v));
  let gatherD = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v - texel.y));
  let gatherU = textureGather(0, heightTex, heightSamp, vec2<f32>(u, v + texel.y));

  let dzdx = (gatherR.x + 2.0 * gatherR.y + gatherR.z)
           - (gatherL.x + 2.0 * gatherL.y + gatherL.z);
  let dzdy = (gatherU.x + 2.0 * gatherU.y + gatherU.z)
           - (gatherD.x + 2.0 * gatherD.y + gatherD.z);

  let cellWorldX = camera.hmScaleX / dims.x;
  let cellWorldZ = camera.hmScaleZ / dims.y;
  let scale = (cellWorldX + cellWorldZ) * 0.5;

  return normalize(vec3<f32>(-dzdx, scale * 8.0, -dzdy));
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @location(0) pos: vec3<f32>,
  @location(1) col: vec4<f32>,
) -> VsOut {
  var out: VsOut;

  let uv = vec2<f32>(
    select(-1.0, 1.0, (vi & 1u) != 0u),
    select(-1.0, 1.0, (vi & 2u) != 0u),
  );

  let toCamera = camera.cameraPos.xyz - pos;
  let dist = length(toCamera);
  let distScale = clamp(1.0 + 0.12 * log2(max(dist / 200.0, 1.0)), 1.0, 2.5);

  let baseRadius = camera.pointSize * 0.5;
  let scaledRadius = baseRadius * distScale;
  let billboardScale = scaledRadius * 2.6;

  let wp = pos
    + camera.right.xyz * uv.x * billboardScale
    + camera.up.xyz * uv.y * billboardScale;

  out.pos = camera.viewProj * vec4<f32>(wp, 1.0);
  out.color = col;
  out.worldPos = wp;
  out.center = pos;
  out.localUV = uv;
  let lodNear = camera.lodThreshold * 0.8;
  if (dist > lodNear || camera.lodThreshold == 0.0) {
    out.sobelNormal = computeSobelNormal(pos);
  } else {
    out.sobelNormal = vec3<f32>(0.0, 1.0, 0.0);
  }
  out.camDist = dist;
  out.radius = scaledRadius;
  return out;
}

struct FsOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c > vec3<f32>(0.04045));
}

fn tonemap(hdr: vec3<f32>) -> vec3<f32> {
  let mapped = hdr / (vec3<f32>(1.0) + hdr);
  return pow(clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}

fn blinnPhong(N: vec3<f32>, worldPos: vec3<f32>, baseColorSrgb: vec3<f32>) -> vec3<f32> {
  let baseColor = srgbToLinear(baseColorSrgb);
  let L = normalize(camera.sunDir.xyz);
  let V = normalize(camera.cameraPos.xyz - worldPos);
  let H = normalize(L + V);

  let NdotL = dot(N, L);
  let diffuse = NdotL * 0.5 + 0.5;
  let lighting = 0.30 + 0.70 * diffuse;

  let NdotH = max(dot(N, H), 0.0);
  let specular = 0.12 * pow(NdotH, 24.0);

  return tonemap(baseColor * lighting + vec3<f32>(specular));
}

@fragment
fn fs_main(in: VsOut) -> FsOut {
  var out: FsOut;

  let lodNear = camera.lodThreshold * 0.8;
  let lodFar  = camera.lodThreshold * 1.2;

  // NEAR PATH: Raytraced box imposter
  if (in.camDist < lodFar) {
    let rayDir = normalize(in.worldPos - camera.cameraPos.xyz);
    let localOrigin = camera.cameraPos.xyz - in.center;
    let invDir = 1.0 / rayDir;

    let half = in.radius * 1.02;
    let t0 = (-half - localOrigin) * invDir;
    let t1 = ( half - localOrigin) * invDir;

    let tmin = min(t0, t1);
    let tmax = max(t0, t1);

    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar  = min(min(tmax.x, tmax.y), tmax.z);

    if (tNear > tFar || tFar < 0.0) {
      if (in.camDist < lodNear) { discard; }
    } else {
      let hitPos = camera.cameraPos.xyz + rayDir * tNear;
      let clipPos = camera.viewProj * vec4<f32>(hitPos, 1.0);

      var faceNormal = vec3<f32>(0.0);
      if (tNear == tmin.x) { faceNormal = vec3<f32>(-sign(rayDir.x), 0.0, 0.0); }
      else if (tNear == tmin.y) { faceNormal = vec3<f32>(0.0, -sign(rayDir.y), 0.0); }
      else { faceNormal = vec3<f32>(0.0, 0.0, -sign(rayDir.z)); }

      let boxColor = blinnPhong(faceNormal, hitPos, in.color.rgb);
      let boxDepth = clipPos.z / clipPos.w;

      if (in.camDist > lodNear) {
        let t = smoothstep(lodNear, lodFar, in.camDist);

        let dist2 = dot(in.localUV, in.localUV);
        if (dist2 > 1.0) { discard; }
        let edge = 1.0 - smoothstep(0.6, 1.0, sqrt(dist2));
        let N = normalize(in.sobelNormal);
        let discColor = blinnPhong(N, in.center, in.color.rgb);

        out.color = vec4<f32>(mix(boxColor, discColor, t), mix(in.color.a, in.color.a * edge, t));
        out.depth = mix(boxDepth, in.pos.z, t);
      } else {
        out.color = vec4<f32>(boxColor, in.color.a);
        out.depth = boxDepth;
      }
      return out;
    }
  }

  // FAR PATH: Smooth disc billboard with Sobel normal
  let dist2 = dot(in.localUV, in.localUV);
  if (dist2 > 1.0) { discard; }

  let edge = 1.0 - smoothstep(0.5, 1.0, sqrt(dist2));
  let N = normalize(in.sobelNormal);
  let color = blinnPhong(N, in.center, in.color.rgb);

  out.color = vec4<f32>(color, in.color.a * edge);
  out.depth = in.pos.z;
  return out;
}
`;

const TERRAIN_SHADER = /* wgsl */`
struct Camera {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  cameraPos: vec4<f32>,
  pointSize: f32,
  lodThreshold: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  sunDir: vec4<f32>,
  hmOriginX: f32,
  hmOriginZ: f32,
  hmScaleX: f32,
  hmScaleZ: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct TerrainVsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn terrain_vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) col: vec4<f32>,
) -> TerrainVsOut {
  var out: TerrainVsOut;
  out.pos = camera.viewProj * vec4<f32>(position, 1.0);
  out.color = col;
  out.normal = normal;
  return out;
}

@fragment
fn terrain_fs(in: TerrainVsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let ndotl = max(dot(n, normalize(camera.sunDir.xyz)), 0.3);
  return vec4<f32>(in.color.rgb * ndotl, in.color.a);
}
`;

import type { VisibleNode, FlatOctree } from './lod/types';

const MAX_BUFFER_POINTS = 50_000_000;

interface PointChunkBuffers {
  pos: GPUBuffer;
  col: GPUBuffer;
  pointOffset: number;
  count: number;
}

export interface HeightmapParams {
  data: Float32Array;
  width: number;
  height: number;
  originX: number;
  originZ: number;
  scaleX: number;
  scaleZ: number;
}

export class LidarRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private terrainPipeline!: GPURenderPipeline;
  private cameraBuffer!: GPUBuffer;
  private pointBindGroup!: GPUBindGroup;
  private terrainBindGroup!: GPUBindGroup;
  private pointBindGroupLayout!: GPUBindGroupLayout;
  private terrainBindGroupLayout!: GPUBindGroupLayout;
  private depthTexture!: GPUTexture;
  private depthView!: GPUTextureView;
  private heightTexture!: GPUTexture;
  private heightSampler!: GPUSampler;
  private cameraBufferVoxel!: GPUBuffer;
  private pointBindGroupVoxel!: GPUBindGroup;
  private uniformCache = new Float32Array(40);
  private _tempFloat = new Float32Array(1);

  private buffers: { pos: GPUBuffer; col: GPUBuffer; count: number }[] = [];
  private terrainMesh: { vertBuf: GPUBuffer; colBuf: GPUBuffer; idxBuf: GPUBuffer; count: number } | null = null;
  private canvasWidth = 1;
  private canvasHeight = 1;
  private hmOriginX = 0;
  private hmOriginZ = 0;
  private hmScaleX = 1;
  private hmScaleZ = 1;
  totalPoints = 0;
  pointSize = 0.59;
  lodThreshold = 500;
  terrainVisible = true;
  private pointChunkCapacity = MAX_BUFFER_POINTS;

  // Octree LOD buffers
  private leafChunks: PointChunkBuffers[] = [];
  private voxelChunks: PointChunkBuffers[] = [];
  private octreeMaxDepth = 0;
  lastViewProj: Float32Array = new Float32Array(16);
  lastCamPos: [number, number, number] = [0, 0, 0];
  lastCamFwd: [number, number, number] = [0, 0, -1];

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU non supporté');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Pas de GPUAdapter');

    const features: GPUFeatureName[] = [];
    if (adapter.features.has('float32-filterable')) features.push('float32-filterable');
    this.device = await adapter.requestDevice({ requiredFeatures: features });
    this.pointChunkCapacity = this.computePointChunkCapacity();

    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    const hasF32Filter = this.device.features.has('float32-filterable');
    this.pointBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: hasF32Filter ? 'float' : 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: hasF32Filter ? 'filtering' : 'non-filtering' } },
      ],
    });

    this.terrainBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const shader = this.device.createShaderModule({ code: SHADER });
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.pointBindGroupLayout] }),
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
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    const terrainShader = this.device.createShaderModule({ code: TERRAIN_SHADER });
    this.terrainPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.terrainBindGroupLayout] }),
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
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    // Camera uniform: 160 bytes
    this.cameraBuffer = this.device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraBufferVoxel = this.device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heightTexture = this.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.heightSampler = this.device.createSampler({
      magFilter: hasF32Filter ? 'linear' : 'nearest',
      minFilter: hasF32Filter ? 'linear' : 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.rebuildBindGroups();
    this.resize(canvas.width, canvas.height);
  }

  private rebuildBindGroups() {
    this.pointBindGroup = this.device.createBindGroup({
      layout: this.pointBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.heightSampler },
      ],
    });
    this.pointBindGroupVoxel = this.device.createBindGroup({
      layout: this.pointBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBufferVoxel } },
        { binding: 1, resource: this.heightTexture.createView() },
        { binding: 2, resource: this.heightSampler },
      ],
    });
    this.terrainBindGroup = this.device.createBindGroup({
      layout: this.terrainBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
      ],
    });
  }

  setHeightmap(params: HeightmapParams) {
    this.hmOriginX = params.originX;
    this.hmOriginZ = params.originZ;
    this.hmScaleX = params.scaleX;
    this.hmScaleZ = params.scaleZ;

    if (this.heightTexture) this.heightTexture.destroy();

    this.heightTexture = this.device.createTexture({
      size: [params.width, params.height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture: this.heightTexture },
      params.data,
      { bytesPerRow: params.width * 4 },
      { width: params.width, height: params.height },
    );

    this.rebuildBindGroups();
  }

  resize(w: number, h: number) {
    this.canvasWidth = w;
    this.canvasHeight = h;
    if (this.depthTexture) this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  setOctreeData(octree: FlatOctree): void {
    this.destroyPointChunks(this.leafChunks);
    this.destroyPointChunks(this.voxelChunks);
    this.leafChunks = [];
    this.voxelChunks = [];

    this.octreeMaxDepth = octree.maxDepthReached;
    this.totalPoints = octree.totalLeafPoints;

    if (octree.leafPositions.byteLength > 0) {
      this.leafChunks = this.uploadPointChunks(octree.leafPositions, octree.leafColors);
    }

    if (octree.voxelPositions.byteLength > 0) {
      this.voxelChunks = this.uploadPointChunks(octree.voxelPositions, octree.voxelColors);
    }
  }

  renderLOD(visibleNodes: VisibleNode[], voxelPointSize?: number): void {
    if (!this.device) return;
    if (this.leafChunks.length === 0 && this.voxelChunks.length === 0 && !this.terrainMesh) return;

    const colorView = this.context.getCurrentTexture().createView();
    const effectiveVoxelSize = voxelPointSize ?? this.pointSize;

    if (effectiveVoxelSize !== this.pointSize) {
      this._tempFloat[0] = effectiveVoxelSize;
      this.device.queue.writeBuffer(this.cameraBufferVoxel, 28 * 4, this._tempFloat);
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.76, g: 0.87, b: 0.96, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.terrainMesh && this.terrainVisible) {
      pass.setPipeline(this.terrainPipeline);
      pass.setBindGroup(0, this.terrainBindGroup);
      pass.setVertexBuffer(0, this.terrainMesh.vertBuf);
      pass.setVertexBuffer(1, this.terrainMesh.colBuf);
      pass.setIndexBuffer(this.terrainMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.terrainMesh.count);
    }

    pass.setPipeline(this.pipeline);

    if (this.voxelChunks.length > 0) {
      pass.setBindGroup(0, this.pointBindGroupVoxel);
      this.drawNodesBatched(pass, visibleNodes, this.voxelChunks, true);
    }

    if (this.leafChunks.length > 0) {
      pass.setBindGroup(0, this.pointBindGroup);
      this.drawNodesBatched(pass, visibleNodes, this.leafChunks, false);
    }

    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private drawNodesBatched(
    pass: GPURenderPassEncoder,
    nodes: VisibleNode[],
    chunks: PointChunkBuffers[],
    isVoxel: boolean,
  ): void {
    const chunkState = { index: -1 };
    let batchStart = -1;
    let batchCount = 0;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.isVoxel !== isVoxel || n.count === 0) continue;

      if (n.density < 1.0) {
        if (batchStart >= 0) {
          this.drawRange(pass, chunks, batchStart, batchCount, chunkState);
          batchStart = -1;
          batchCount = 0;
        }
        if (n.density > 0) {
          this.drawSegmentedThinnedNode(pass, chunks, n.offset, n.count, n.density, chunkState);
        }
      } else {
        if (batchStart >= 0 && n.offset === batchStart + batchCount) {
          batchCount += n.count;
        } else {
          if (batchStart >= 0) this.drawRange(pass, chunks, batchStart, batchCount, chunkState);
          batchStart = n.offset;
          batchCount = n.count;
        }
      }
    }
    if (batchStart >= 0) this.drawRange(pass, chunks, batchStart, batchCount, chunkState);
  }

  private computePointChunkCapacity(): number {
    const maxBufferSize = this.device.limits.maxBufferSize;
    return Math.max(
      1,
      Math.min(
        MAX_BUFFER_POINTS,
        Math.floor(maxBufferSize / 12),
        Math.floor(maxBufferSize / 4),
      ),
    );
  }

  private destroyPointChunks(chunks: PointChunkBuffers[]): void {
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].pos.destroy();
      chunks[i].col.destroy();
    }
  }

  private uploadPointChunks(positions: Float32Array, colors: Uint8Array): PointChunkBuffers[] {
    const chunks: PointChunkBuffers[] = [];
    const totalPoints = positions.length / 3;

    for (let pointOffset = 0; pointOffset < totalPoints; pointOffset += this.pointChunkCapacity) {
      const count = Math.min(this.pointChunkCapacity, totalPoints - pointOffset);

      const pos = this.device.createBuffer({
        size: count * 12,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(pos, 0, positions, pointOffset * 3, count * 3);

      const col = this.device.createBuffer({
        size: count * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(col, 0, colors, pointOffset * 4, count * 4);

      chunks.push({ pos, col, pointOffset, count });
    }

    return chunks;
  }

  private drawSegmentedThinnedNode(
    pass: GPURenderPassEncoder,
    chunks: PointChunkBuffers[],
    offset: number,
    count: number,
    density: number,
    chunkState: { index: number },
  ): void {
    const targetCount = Math.max(1, Math.floor(count * density));
    const segmentCount = this.getThinningSegmentCount(count);
    let keptSoFar = 0;

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const segmentStart = offset + Math.floor((segmentIndex * count) / segmentCount);
      const segmentEnd = offset + Math.floor(((segmentIndex + 1) * count) / segmentCount);
      const segmentCountPoints = segmentEnd - segmentStart;
      if (segmentCountPoints <= 0) continue;

      const nextKept = Math.round(((segmentIndex + 1) * targetCount) / segmentCount);
      const keepCount = nextKept - keptSoFar;
      keptSoFar = nextKept;
      if (keepCount <= 0) continue;

      const slack = segmentCountPoints - keepCount;
      const windowOffset = slack > 0 ? (slack >>> 1) : 0;
      this.drawRange(pass, chunks, segmentStart + windowOffset, keepCount, chunkState);
    }
  }

  private getThinningSegmentCount(count: number): number {
    if (count <= 1) return 1;
    if (count >= 100_000) return 8;
    if (count >= 50_000) return 6;
    if (count >= 20_000) return 4;
    if (count >= 5_000) return 2;
    return 1;
  }

  private drawRange(
    pass: GPURenderPassEncoder,
    chunks: PointChunkBuffers[],
    offset: number,
    count: number,
    chunkState: { index: number },
  ): void {
    let remaining = count;
    let currentOffset = offset;

    while (remaining > 0) {
      const chunkIndex = this.findChunkIndex(chunks, currentOffset, chunkState.index);
      if (chunkIndex < 0) return;

      const chunk = chunks[chunkIndex];
      if (chunkState.index !== chunkIndex) {
        pass.setVertexBuffer(0, chunk.pos);
        pass.setVertexBuffer(1, chunk.col);
        chunkState.index = chunkIndex;
      }

      const localOffset = currentOffset - chunk.pointOffset;
      const drawCount = Math.min(remaining, chunk.count - localOffset);
      pass.draw(4, drawCount, 0, localOffset);

      currentOffset += drawCount;
      remaining -= drawCount;
    }
  }

  private findChunkIndex(chunks: PointChunkBuffers[], offset: number, hint: number): number {
    let index = Math.max(0, hint);
    while (index < chunks.length) {
      const chunk = chunks[index];
      if (offset < chunk.pointOffset + chunk.count) return index;
      index++;
    }
    return -1;
  }

  setPointCloud(positions: Float32Array, colors: Uint8Array) {
    for (const b of this.buffers) { b.pos.destroy(); b.col.destroy(); }
    this.buffers = [];
    this.totalPoints = positions.length / 3;

    let offset = 0;
    while (offset < this.totalPoints) {
      const count = Math.min(this.pointChunkCapacity, this.totalPoints - offset);

      const pos = this.device.createBuffer({ size: count * 12, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(pos, 0, positions, offset * 3, count * 3);

      const col = this.device.createBuffer({ size: count * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(col, 0, colors, offset * 4, count * 4);

      this.buffers.push({ pos, col, count });
      offset += count;
    }
  }

  setMesh(vertices: Float32Array, colors: Uint8Array, indices: Uint32Array): void {
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
    }

    const vertBuf = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertBuf, 0, vertices);

    const colBuf = this.device.createBuffer({
      size: colors.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(colBuf, 0, colors);

    const idxBuf = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(idxBuf, 0, indices);

    this.terrainMesh = { vertBuf, colBuf, idxBuf, count: indices.length };
  }

  updateCamera(view: Float32Array, proj: Float32Array) {
    const vp = mat4Multiply(proj, view);

    const right = [view[0], view[4], view[8], 0];
    const up = [view[1], view[5], view[9], 0];

    const camX = -(view[0] * view[12] + view[1] * view[13] + view[2] * view[14]);
    const camY = -(view[4] * view[12] + view[5] * view[13] + view[6] * view[14]);
    const camZ = -(view[8] * view[12] + view[9] * view[13] + view[10] * view[14]);

    const sunDir = [0.4, 0.8, 0.45, 0];

    this.lastViewProj = vp;
    this.lastCamPos = [camX, camY, camZ];
    this.lastCamFwd = [-view[2], -view[6], -view[10]];

    const f = this.uniformCache;
    f.set(vp, 0);
    f[16] = right[0]; f[17] = right[1]; f[18] = right[2]; f[19] = right[3];
    f[20] = up[0]; f[21] = up[1]; f[22] = up[2]; f[23] = up[3];
    f[24] = camX; f[25] = camY; f[26] = camZ; f[27] = 1;
    f[28] = this.pointSize;
    f[29] = this.lodThreshold;
    f[30] = this.canvasWidth;
    f[31] = this.canvasHeight;
    f[32] = sunDir[0]; f[33] = sunDir[1]; f[34] = sunDir[2]; f[35] = sunDir[3];
    f[36] = this.hmOriginX;
    f[37] = this.hmOriginZ;
    f[38] = this.hmScaleX;
    f[39] = this.hmScaleZ;

    this.device.queue.writeBuffer(this.cameraBuffer, 0, f);
    this.device.queue.writeBuffer(this.cameraBufferVoxel, 0, f);
  }

  render() {
    if (!this.device || (this.buffers.length === 0 && !this.terrainMesh)) return;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.76, g: 0.87, b: 0.96, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.terrainMesh && this.terrainVisible) {
      pass.setPipeline(this.terrainPipeline);
      pass.setBindGroup(0, this.terrainBindGroup);
      pass.setVertexBuffer(0, this.terrainMesh.vertBuf);
      pass.setVertexBuffer(1, this.terrainMesh.colBuf);
      pass.setIndexBuffer(this.terrainMesh.idxBuf, 'uint32');
      pass.drawIndexed(this.terrainMesh.count);
    }

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.pointBindGroup);

    for (const b of this.buffers) {
      pass.setVertexBuffer(0, b.pos);
      pass.setVertexBuffer(1, b.col);
      pass.draw(4, b.count);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy() {
    for (const b of this.buffers) { b.pos.destroy(); b.col.destroy(); }
    if (this.terrainMesh) {
      this.terrainMesh.vertBuf.destroy();
      this.terrainMesh.colBuf.destroy();
      this.terrainMesh.idxBuf.destroy();
    }
    this.destroyPointChunks(this.leafChunks);
    this.destroyPointChunks(this.voxelChunks);
    this.cameraBuffer?.destroy();
    this.cameraBufferVoxel?.destroy();
    this.depthTexture?.destroy();
    this.heightTexture?.destroy();
  }
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[0 * 4 + i] * b[j * 4 + 0] +
        a[1 * 4 + i] * b[j * 4 + 1] +
        a[2 * 4 + i] * b[j * 4 + 2] +
        a[3 * 4 + i] * b[j * 4 + 3];
    }
  }
  return out;
}
