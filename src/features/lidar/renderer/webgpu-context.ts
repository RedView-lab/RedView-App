export interface WebGPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<WebGPUContext> {
  if (!navigator.gpu) {
    throw new Error('WebGPU not supported in this browser');
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error('No WebGPU adapter found');
  }

  const device = await adapter.requestDevice({
    requiredFeatures: [],
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });

  device.lost.then((info) => {
    console.error('[lidar] WebGPU device lost:', info.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to get WebGPU canvas context');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  return { device, context, format, canvas };
}

export function destroyWebGPU(ctx: WebGPUContext): void {
  ctx.context.unconfigure();
  ctx.device.destroy();
}
