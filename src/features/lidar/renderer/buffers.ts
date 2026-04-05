// Uniform buffer layout (128 bytes):
//   0: mat4x4 projMatrix  (64 bytes)
//  64: vec2 viewportSize   (8 bytes)
//  72: f32 pointSize       (4 bytes)
//  76: f32 opacity          (4 bytes)
//  80: f32 originX          (4 bytes)
//  84: f32 originY          (4 bytes)
//  88: f32 originZ          (4 bytes)
//  92: f32 _pad0            (4 bytes)
//  96: vec3 sunDir          (12 bytes)
// 108: f32 _pad1            (4 bytes)
// 112: vec3 cameraPos       (12 bytes)
// 124: f32 _pad2            (4 bytes)

export const UNIFORM_BUFFER_SIZE = 128;

const QUAD_VERTICES = new Float32Array([
  -1, -1,
   1, -1,
  -1,  1,
   1,  1,
]);

export function createQuadVertexBuffer(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(QUAD_VERTICES);
  buffer.unmap();
  return buffer;
}

export function createUniformBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    size: UNIFORM_BUFFER_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export interface UniformData {
  projMatrix: Float32Array;
  viewportWidth: number;
  viewportHeight: number;
  pointSize: number;
  opacity: number;
  originX: number;
  originY: number;
  originZ: number;
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
  cameraPosX: number;
  cameraPosY: number;
  cameraPosZ: number;
}

export function writeUniforms(device: GPUDevice, buffer: GPUBuffer, data: UniformData): void {
  const buf = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
  const f32 = new Float32Array(buf);

  f32.set(data.projMatrix, 0);

  f32[16] = data.viewportWidth;
  f32[17] = data.viewportHeight;
  f32[18] = data.pointSize;
  f32[19] = data.opacity;
  f32[20] = data.originX;
  f32[21] = data.originY;
  f32[22] = data.originZ;
  f32[23] = 0;
  f32[24] = data.sunDirX;
  f32[25] = data.sunDirY;
  f32[26] = data.sunDirZ;
  f32[27] = 0;
  f32[28] = data.cameraPosX;
  f32[29] = data.cameraPosY;
  f32[30] = data.cameraPosZ;
  f32[31] = 0;

  device.queue.writeBuffer(buffer, 0, buf);
}

export function createInstanceBuffer(
  device: GPUDevice,
  positions: Float32Array,
  colors: Uint8Array,
  normals: Float32Array,
  count: number,
): GPUBuffer {
  const instanceData = new Float32Array(count * 9);

  for (let i = 0; i < count; i++) {
    const base = i * 9;
    instanceData[base] = positions[i * 3];
    instanceData[base + 1] = positions[i * 3 + 1];
    instanceData[base + 2] = positions[i * 3 + 2];
    instanceData[base + 3] = colors[i * 3] / 255;
    instanceData[base + 4] = colors[i * 3 + 1] / 255;
    instanceData[base + 5] = colors[i * 3 + 2] / 255;
    instanceData[base + 6] = normals[i * 3];
    instanceData[base + 7] = normals[i * 3 + 1];
    instanceData[base + 8] = normals[i * 3 + 2];
  }

  const buffer = device.createBuffer({
    size: instanceData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(instanceData);
  buffer.unmap();
  return buffer;
}
