import type { WebGPUContext } from './webgpu-context';
import type { FxaaPipeline } from './pipeline';

export interface FxaaResources {
  sceneTexture: GPUTexture;
  sceneTextureView: GPUTextureView;
  depthTexture: GPUTexture;
  depthTextureView: GPUTextureView;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
}

export function createFxaaResources(
  ctx: WebGPUContext,
  fxaa: FxaaPipeline,
  width: number,
  height: number,
): FxaaResources {
  const { device } = ctx;

  const sceneTexture = device.createTexture({
    size: { width, height },
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  const depthTexture = device.createTexture({
    size: { width, height },
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const sceneTextureView = sceneTexture.createView();
  const depthTextureView = depthTexture.createView();

  const bindGroup = device.createBindGroup({
    layout: fxaa.bindGroupLayout,
    entries: [
      { binding: 0, resource: sceneTextureView },
      { binding: 1, resource: fxaa.sampler },
    ],
  });

  return { sceneTexture, sceneTextureView, depthTexture, depthTextureView, bindGroup, width, height };
}

export function destroyFxaaResources(res: FxaaResources): void {
  res.sceneTexture.destroy();
  res.depthTexture.destroy();
}
