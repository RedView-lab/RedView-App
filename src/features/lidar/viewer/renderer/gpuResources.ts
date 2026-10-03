/** GPU buffers, textures and samplers created by `LidarRenderer`. */

/** Vertex/colour/index buffers of an indexed overlay mesh (terrain, preview, route). */
export interface MeshBuffers {
  vertBuf: GPUBuffer;
  colBuf: GPUBuffer;
  idxBuf: GPUBuffer;
  count: number;
}

export function createUniformBuffer(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

export function createVertexBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
  const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
  return buffer;
}

export function createFloatTexture(device: GPUDevice, width: number, height: number, data: Float32Array): GPUTexture {
  const texture = device.createTexture({
    size: [width, height],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data as Float32Array<ArrayBuffer>,
    { bytesPerRow: width * 4 },
    { width, height },
  );
  return texture;
}

export function createRgbaTexture(device: GPUDevice, width: number, height: number, data: Uint8Array): GPUTexture {
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data as Uint8Array<ArrayBuffer>,
    { bytesPerRow: width * 4 },
    { width, height },
  );
  return texture;
}

/** `width`×1 colour ramp, transparent until the first `writeRampTexture`. */
export function createRampTexture(device: GPUDevice, width: number): GPUTexture {
  return createRgbaTexture(device, width, 1, new Uint8Array(width * 4));
}

export function writeRampTexture(device: GPUDevice, texture: GPUTexture, data: Uint8Array, width: number): void {
  device.queue.writeTexture(
    { texture },
    data as Uint8Array<ArrayBuffer>,
    { bytesPerRow: width * 4 },
    { width, height: 1 },
  );
}

export function createRampSampler(device: GPUDevice, filter: GPUFilterMode): GPUSampler {
  return device.createSampler({
    magFilter: filter,
    minFilter: filter,
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
}

export function createMeshBuffers(
  device: GPUDevice,
  vertices: Float32Array,
  colors: Uint8Array,
  indices: Uint32Array,
  count: number,
): MeshBuffers {
  const vertBuf = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertBuf, 0, vertices as Float32Array<ArrayBuffer>);
  const colBuf = device.createBuffer({ size: colors.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(colBuf, 0, colors as Uint8Array<ArrayBuffer>);
  const idxBuf = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(idxBuf, 0, indices as Uint32Array<ArrayBuffer>);
  return { vertBuf, colBuf, idxBuf, count };
}

export function destroyMeshBuffers(mesh: MeshBuffers | null): void {
  if (!mesh) return;
  mesh.vertBuf.destroy();
  mesh.colBuf.destroy();
  mesh.idxBuf.destroy();
}

/** Draws an indexed mesh with `pipeline` (bind group 0 already set). */
export function drawMesh(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, mesh: MeshBuffers): void {
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, mesh.vertBuf);
  pass.setVertexBuffer(1, mesh.colBuf);
  pass.setIndexBuffer(mesh.idxBuf, 'uint32');
  pass.drawIndexed(mesh.count);
}

/** Heightmap rows bottom-up (texture row 0 = last grid row). */
export function flipRows(data: Float32Array, width: number, height: number): Float32Array {
  const flipped = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      flipped[dstRow + x] = data[srcRow + x]!;
    }
  }
  return flipped;
}

/** First `count` bytes mapped to [0, 1] (8-bit shadow map → r32float texture). */
export function unitFloatsFromBytes(bytes: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = bytes[i]! / 255;
  }
  return out;
}
