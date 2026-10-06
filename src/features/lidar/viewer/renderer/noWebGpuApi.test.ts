import { describe, expect, it } from 'vitest';

/**
 * Firefox on Linux (and Safari before 26) has no WebGPU API at all: not even
 * `GPUShaderStage` or `GPUBufferUsage`. A WebGPU constant read at module
 * level threw on import there and took the whole viewer down, WebGL 2
 * included. Node has none of those globals either.
 */
describe('renderer modules without the WebGPU API', () => {
  it('evaluate on import', async () => {
    expect((globalThis as { GPUShaderStage?: unknown }).GPUShaderStage).toBeUndefined();
    await expect(import('../renderer')).resolves.toHaveProperty('WebGpuLidarRenderer');
    await expect(import('./createRenderer')).resolves.toHaveProperty('createLidarRenderer');
    await expect(import('./webgl/glRenderer')).resolves.toHaveProperty('WebGlLidarRenderer');
  });
});
