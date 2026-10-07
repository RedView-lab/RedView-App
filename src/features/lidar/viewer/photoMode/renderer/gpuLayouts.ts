// ============================================
// Photo mode — compact bind group layouts
// ============================================
//
// Explicit layouts (no `layout: 'auto'`): several passes read r32float /
// rg32float textures and depth textures, whose sample types an automatic
// layout would get wrong for unfilterable formats. Bindings are numbered in
// the order given.

export type LayoutEntry =
  | { uniform: true }
  | { storage: 'read-only-storage' | 'storage' }
  | { texture: GPUTextureSampleType; dimension?: GPUTextureViewDimension }
  | { sampler: GPUSamplerBindingType }
  | { storageTexture: GPUTextureFormat; dimension?: GPUTextureViewDimension };

export function bindGroupLayout(device: GPUDevice, visibility: number, entries: LayoutEntry[]): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: entries.map((entry, binding): GPUBindGroupLayoutEntry => {
      if ('uniform' in entry) return { binding, visibility, buffer: { type: 'uniform' } };
      if ('storage' in entry) return { binding, visibility, buffer: { type: entry.storage } };
      if ('texture' in entry) {
        return { binding, visibility, texture: { sampleType: entry.texture, viewDimension: entry.dimension ?? '2d' } };
      }
      if ('sampler' in entry) return { binding, visibility, sampler: { type: entry.sampler } };
      return {
        binding,
        visibility,
        storageTexture: { access: 'write-only', format: entry.storageTexture, viewDimension: entry.dimension ?? '2d' },
      };
    }),
  });
}

export function bindGroup(device: GPUDevice, layout: GPUBindGroupLayout, resources: GPUBindingResource[]): GPUBindGroup {
  return device.createBindGroup({ layout, entries: resources.map((resource, binding) => ({ binding, resource })) });
}

export function buffer(b: GPUBuffer): GPUBufferBinding {
  return { buffer: b };
}
