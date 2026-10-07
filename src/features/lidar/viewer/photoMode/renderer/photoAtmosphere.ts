// ============================================
// Photo mode — atmosphere look-up tables (Hillaire 2020)
// ============================================

import { bindGroup, bindGroupLayout, buffer } from './gpuLayouts';
import {
  AERIAL_PERSPECTIVE_SHADER,
  AERIAL_PERSPECTIVE_SIZE,
  MULTISCATTER_LUT_SHADER,
  MULTISCATTER_LUT_SIZE,
  SKY_IRRADIANCE_SHADER,
  SKY_VIEW_LUT_SHADER,
  SKY_VIEW_LUT_SIZE,
  TRANSMITTANCE_LUT_SHADER,
  TRANSMITTANCE_LUT_SIZE,
} from './shaders/atmosphereShaders';

function computePipeline(device: GPUDevice, code: string, layout: GPUBindGroupLayout): GPUComputePipeline {
  return device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
  });
}

export class PhotoAtmosphere {
  readonly transmittance: GPUTexture;
  readonly multiScatter: GPUTexture;
  readonly skyView: GPUTexture;
  readonly aerialPerspective: GPUTexture;
  private readonly transmittancePipeline: GPUComputePipeline;
  private readonly multiScatterPipeline: GPUComputePipeline;
  private readonly skyViewPipeline: GPUComputePipeline;
  private readonly aerialPipeline: GPUComputePipeline;
  private readonly irradiancePipeline: GPUComputePipeline;
  private readonly transmittanceGroup: GPUBindGroup;
  private readonly multiScatterGroup: GPUBindGroup;
  private readonly skyViewGroup: GPUBindGroup;
  private readonly aerialGroup: GPUBindGroup;
  private readonly irradianceGroup: GPUBindGroup;

  constructor(device: GPUDevice, uniforms: GPUBuffer, lighting: GPUBuffer, linearClamp: GPUSampler) {
    const C = GPUShaderStage.COMPUTE;
    const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.transmittance = device.createTexture({ size: TRANSMITTANCE_LUT_SIZE, format: 'rgba16float', usage: storageUsage });
    this.multiScatter = device.createTexture({ size: [MULTISCATTER_LUT_SIZE, MULTISCATTER_LUT_SIZE], format: 'rgba16float', usage: storageUsage });
    this.skyView = device.createTexture({ size: SKY_VIEW_LUT_SIZE, format: 'rgba16float', usage: storageUsage });
    this.aerialPerspective = device.createTexture({
      size: [AERIAL_PERSPECTIVE_SIZE, AERIAL_PERSPECTIVE_SIZE, AERIAL_PERSPECTIVE_SIZE],
      dimension: '3d',
      format: 'rgba16float',
      usage: storageUsage,
    });

    const transmittanceLayout = bindGroupLayout(device, C, [{ uniform: true }, { storageTexture: 'rgba16float' }]);
    this.transmittancePipeline = computePipeline(device, TRANSMITTANCE_LUT_SHADER, transmittanceLayout);
    this.transmittanceGroup = bindGroup(device, transmittanceLayout, [buffer(uniforms), this.transmittance.createView()]);

    const multiLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { sampler: 'filtering' }, { storageTexture: 'rgba16float' },
    ]);
    this.multiScatterPipeline = computePipeline(device, MULTISCATTER_LUT_SHADER, multiLayout);
    this.multiScatterGroup = bindGroup(device, multiLayout, [
      buffer(uniforms), this.transmittance.createView(), linearClamp, this.multiScatter.createView(),
    ]);

    const skyLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { sampler: 'filtering' }, { texture: 'float' }, { storageTexture: 'rgba16float' },
    ]);
    this.skyViewPipeline = computePipeline(device, SKY_VIEW_LUT_SHADER, skyLayout);
    this.skyViewGroup = bindGroup(device, skyLayout, [
      buffer(uniforms), this.transmittance.createView(), linearClamp, this.multiScatter.createView(), this.skyView.createView(),
    ]);

    const aerialLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { sampler: 'filtering' }, { texture: 'float' },
      { storageTexture: 'rgba16float', dimension: '3d' },
    ]);
    this.aerialPipeline = computePipeline(device, AERIAL_PERSPECTIVE_SHADER, aerialLayout);
    this.aerialGroup = bindGroup(device, aerialLayout, [
      buffer(uniforms), this.transmittance.createView(), linearClamp, this.multiScatter.createView(),
      this.aerialPerspective.createView({ dimension: '3d' }),
    ]);

    const irradianceLayout = bindGroupLayout(device, C, [
      { uniform: true }, { texture: 'float' }, { sampler: 'filtering' }, { texture: 'float' }, { storage: 'storage' },
    ]);
    this.irradiancePipeline = computePipeline(device, SKY_IRRADIANCE_SHADER, irradianceLayout);
    this.irradianceGroup = bindGroup(device, irradianceLayout, [
      buffer(uniforms), this.transmittance.createView(), linearClamp, this.skyView.createView(), buffer(lighting),
    ]);
  }

  /**
   * Encodes the tables that changed: `media` (haze) rebuilds everything,
   * `sky` (sun, camera altitude) the sky view and the irradiance, `view`
   * (camera pose) the aerial perspective.
   */
  encode(encoder: GPUCommandEncoder, changes: { media: boolean; sky: boolean; view: boolean }): void {
    if (!changes.media && !changes.sky && !changes.view) return;
    const pass = encoder.beginComputePass();
    if (changes.media) {
      pass.setPipeline(this.transmittancePipeline);
      pass.setBindGroup(0, this.transmittanceGroup);
      pass.dispatchWorkgroups(Math.ceil(TRANSMITTANCE_LUT_SIZE[0] / 8), Math.ceil(TRANSMITTANCE_LUT_SIZE[1] / 8));
      pass.setPipeline(this.multiScatterPipeline);
      pass.setBindGroup(0, this.multiScatterGroup);
      pass.dispatchWorkgroups(MULTISCATTER_LUT_SIZE, MULTISCATTER_LUT_SIZE);
    }
    if (changes.media || changes.sky) {
      pass.setPipeline(this.skyViewPipeline);
      pass.setBindGroup(0, this.skyViewGroup);
      pass.dispatchWorkgroups(Math.ceil(SKY_VIEW_LUT_SIZE[0] / 8), Math.ceil(SKY_VIEW_LUT_SIZE[1] / 8));
      pass.setPipeline(this.irradiancePipeline);
      pass.setBindGroup(0, this.irradianceGroup);
      pass.dispatchWorkgroups(1);
    }
    if (changes.media || changes.sky || changes.view) {
      pass.setPipeline(this.aerialPipeline);
      pass.setBindGroup(0, this.aerialGroup);
      const g = AERIAL_PERSPECTIVE_SIZE / 4;
      pass.dispatchWorkgroups(g, g, g);
    }
    pass.end();
  }

  destroy(): void {
    this.transmittance.destroy();
    this.multiScatter.destroy();
    this.skyView.destroy();
    this.aerialPerspective.destroy();
  }
}
