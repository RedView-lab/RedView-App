import { describe, expect, it } from 'vitest';

/**
 * Firefox sous Linux (et Safari avant 26) n'a aucune API WebGPU : pas même
 * `GPUShaderStage` ni `GPUBufferUsage`. Une constante WebGPU lue au niveau du
 * module levait une erreur à l'import et faisait tomber tout le viewer, WebGL 2
 * compris. Node n'a aucune de ces globales non plus.
 */
describe('renderer modules without the WebGPU API', () => {
  // Transforme tout le renderer au premier import : 1,3 s à lui seul, au-delà
  // des 5 s par défaut pendant que le contrôle lance tsc, ESLint, knip et madge à côté.
  it('evaluate on import', { timeout: 30_000 }, async () => {
    expect((globalThis as { GPUShaderStage?: unknown }).GPUShaderStage).toBeUndefined();
    await expect(import('../renderer')).resolves.toHaveProperty('WebGpuLidarRenderer');
    await expect(import('./createRenderer')).resolves.toHaveProperty('createLidarRenderer');
    await expect(import('./webgl/glRenderer')).resolves.toHaveProperty('WebGlLidarRenderer');
    await expect(import('../photoMode/renderer/photoRenderer')).resolves.toHaveProperty('PhotoRenderer');
    await expect(import('../photoMode/photoModeController')).resolves.toHaveProperty('PhotoModeController');
  });
});
