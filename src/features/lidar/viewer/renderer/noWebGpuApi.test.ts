import { describe, expect, it } from 'vitest';

/**
 * Firefox on Linux (and Safari before 26) has no WebGPU API at all: not even
 * `GPUShaderStage` or `GPUBufferUsage`. A WebGPU constant read at module
 * level threw on import there and took the whole viewer down, WebGL 2
 * included. Node has none of those globals either.
 */
describe('renderer modules without the WebGPU API', () => {
  // Transforms the whole renderer on first import: 1.3 s alone, over the 5 s
  // default while the gate runs tsc, ESLint, knip and madge beside it.
  it('evaluate on import', { timeout: 30_000 }, async () => {
    expect((globalThis as { GPUShaderStage?: unknown }).GPUShaderStage).toBeUndefined();
    await expect(import('../renderer')).resolves.toHaveProperty('WebGpuLidarRenderer');
    await expect(import('./createRenderer')).resolves.toHaveProperty('createLidarRenderer');
    await expect(import('./webgl/glRenderer')).resolves.toHaveProperty('WebGlLidarRenderer');
    await expect(import('../photoMode/renderer/photoRenderer')).resolves.toHaveProperty('PhotoRenderer');
    await expect(import('../photoMode/photoModeController')).resolves.toHaveProperty('PhotoModeController');
  });
});
