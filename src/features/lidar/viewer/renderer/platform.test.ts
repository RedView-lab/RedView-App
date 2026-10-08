import { describe, expect, it } from 'vitest';
import { resolveWebglPlatformInfo, webglVendorOf } from './platform';

/** Paires vendor/renderer démasquées telles que les navigateurs les rapportent (Chrome = ANGLE, Firefox = natif/assaini). */
const tierOf = (vendor: string, renderer: string) => resolveWebglPlatformInfo(vendor, renderer).profile.tier;

describe('resolveWebglPlatformInfo', () => {
  it('classifies Linux GPUs behind ANGLE (Chrome)', () => {
    expect(tierOf('Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 23.0.4)')).toBe('integrated');
    expect(tierOf('Google Inc. (NVIDIA Corporation)', 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.54.03)')).toBe('discrete');
    expect(tierOf('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 15.0.7, DRM 3.52, 6.5.0), OpenGL 4.6 (Core Profile) Mesa 23.2.1)')).toBe('discrete');
    expect(tierOf('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 15.0.7, DRM 3.54, 6.5.0), OpenGL 4.6)')).toBe('integrated');
    expect(tierOf('Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon 780M (radeonsi, phoenix, LLVM 17.0.6), OpenGL 4.6)')).toBe('integrated');
    expect(tierOf('Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) Arc(tm) A770 Graphics (DG2), OpenGL 4.6)')).toBe('discrete');
  });

  it('classifies the strings Firefox reports on Linux', () => {
    expect(tierOf('Intel', 'Mesa Intel(R) Xe Graphics (TGL GT2)')).toBe('integrated');
    expect(tierOf('AMD', 'AMD Radeon RX 6600 (radeonsi, navi23, LLVM 16.0.6, DRM 3.54, 6.6.0)')).toBe('discrete');
    expect(tierOf('NVIDIA Corporation', 'GeForce GTX 980, or similar')).toBe('discrete');
    expect(tierOf('Intel', 'Intel(R) HD Graphics 400, or similar')).toBe('integrated');
  });

  it('gives CPU rasterisers the software profile', () => {
    for (const [vendor, renderer] of [
      ['Mesa', 'llvmpipe (LLVM 15.0.7, 256 bits)'],
      ['Google Inc. (Mesa)', 'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)'],
      ['Google Inc. (Google)', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'],
      ['Google Inc. (Microsoft)', 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ]) {
      const info = resolveWebglPlatformInfo(vendor!, renderer!);
      expect(info.profile.tier).toBe('software');
      expect(info.profile.dprCap).toBe(1);
      expect(info.profile.maxBudget).toBeLessThan(2_000_000);
    }
  });

  it('keeps Apple and unknown GPUs on safe profiles', () => {
    expect(tierOf('Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe('apple');
    // Renderer masqué (réglages de confidentialité) : intégré, le budget grandit d'après la cadence.
    expect(tierOf('', '')).toBe('integrated');
    expect(tierOf('Mozilla', 'Mozilla')).toBe('integrated');
  });

  it('returns a profile copy', () => {
    const a = resolveWebglPlatformInfo('NVIDIA Corporation', 'NVIDIA GeForce RTX 4070').profile;
    a.maxCanvasDim = 1;
    expect(resolveWebglPlatformInfo('NVIDIA Corporation', 'NVIDIA GeForce RTX 4070').profile.maxCanvasDim).toBeGreaterThan(1);
  });
});

describe('webglVendorOf', () => {
  it('does not mistake words containing a vendor token', () => {
    expect(webglVendorOf('research arcade')).toBe('');
    expect(webglVendorOf('nvidia geforce')).toBe('nvidia');
  });
});
