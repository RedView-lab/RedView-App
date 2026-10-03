import { translateAppText } from '@/shared/i18n/config';
import type { PlatformProfile } from '../lod/types';
import { resolvePlatformInfo } from './platform';

/**
 * High-performance adapter + device (with `timestamp-query` when offered)
 * and the platform profile that drives MSAA and the point budget.
 */
export async function requestLidarGpu(): Promise<{ device: GPUDevice; profile: PlatformProfile }> {
  if (!navigator.gpu) throw new Error(translateAppText('WebGPU non supporté'));
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error(translateAppText('Pas de GPUAdapter'));

  const { vendor, arch, desc, profile } = resolvePlatformInfo((adapter as unknown as { info?: unknown }).info ?? null);
  console.log(`[LiDAR GPU] Adapter: vendor=${vendor} arch=${arch} desc=${desc}`);

  const features: GPUFeatureName[] = [];
  if (adapter.features.has('timestamp-query')) features.push('timestamp-query');

  const device = await adapter.requestDevice({ requiredFeatures: features });
  device.addEventListener('uncapturederror', (event) => {
    console.error('[LiDAR GPU] Uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
  });
  return { device, profile };
}

/** Viewer overlay message after a GPU device loss (the page must be reloaded). */
export function showDeviceLostNotice(info: GPUDeviceLostInfo): void {
  const statusEl = document.getElementById('status');
  const overlay = document.getElementById('overlay');
  if (statusEl) statusEl.textContent = translateAppText('⚠️ Périphérique GPU perdu : {{reason}}. Rechargez la page.', { reason: info.message || info.reason });
  if (overlay) overlay.classList.remove('hidden');
}
