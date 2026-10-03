import { SCENE_DEPTH_FORMAT, type RendererPipelines } from './rendererPipeline';

/** Offscreen scene render targets of one size. */
export interface SceneTargets {
  width: number;
  height: number;
  /** Single-sample colour (MSAA resolve target), read by the EDL or upscale pass. */
  colorTexture: GPUTexture;
  colorView: GPUTextureView;
  colorMsTexture: GPUTexture | null;
  colorMsView: GPUTextureView | null;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  edlBindGroup: GPUBindGroup;
  blitBindGroup: GPUBindGroup;
}

export interface SceneTargetsConfig {
  device: GPUDevice;
  pipelines: RendererPipelines;
  format: GPUTextureFormat;
  sampleCount: number;
  edlParamsBuffer: GPUBuffer;
  blitSampler: GPUSampler;
}

export function createSceneTargets(
  { device, pipelines, format, sampleCount, edlParamsBuffer, blitSampler }: SceneTargetsConfig,
  width: number,
  height: number,
): SceneTargets {
  const size = [width, height];
  const colorTexture = device.createTexture({
    size,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const colorView = colorTexture.createView();
  const colorMsTexture = sampleCount > 1
    ? device.createTexture({
      size,
      format,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    : null;
  const depthTexture = device.createTexture({
    size,
    format: SCENE_DEPTH_FORMAT,
    sampleCount,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const depthView = depthTexture.createView();
  return {
    width,
    height,
    colorTexture,
    colorView,
    colorMsTexture,
    colorMsView: colorMsTexture?.createView() ?? null,
    depthTexture,
    depthView,
    edlBindGroup: device.createBindGroup({
      layout: pipelines.edlBindGroupLayout,
      entries: [
        { binding: 0, resource: colorView },
        { binding: 1, resource: depthView },
        { binding: 2, resource: { buffer: edlParamsBuffer } },
      ],
    }),
    blitBindGroup: device.createBindGroup({
      layout: pipelines.blitBindGroupLayout,
      entries: [
        { binding: 0, resource: colorView },
        { binding: 1, resource: blitSampler },
      ],
    }),
  };
}

export function destroySceneTargets(targets: SceneTargets | null): void {
  if (!targets) return;
  targets.colorTexture.destroy();
  targets.colorMsTexture?.destroy();
  targets.depthTexture.destroy();
}
