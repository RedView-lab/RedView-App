import { translateAppText } from '@/shared/i18n/config';
import type { PlatformProfile } from '../lod/types';
import { fitProfileToMemory, resolvePlatformInfo, type GpuAdapterInfoFields } from './platform';

/**
 * Attente maximale de `requestAdapter` / `requestDevice`. Certaines piles
 * Vulkan sous Linux (et des navigateurs avec WebGPU derrière un drapeau) ne
 * résolvent jamais ces promesses : le viewer démarre alors en WebGL 2 au lieu de rester bloqué.
 */
const ADAPTER_TIMEOUT_MS = 8_000;
const DEVICE_TIMEOUT_MS = 10_000;

/** Implémentations CPU de WebGPU : WebGL 2 y est plus rapide. */
const SOFTWARE_ADAPTER_SIGNATURES = ['swiftshader', 'llvmpipe', 'lavapipe', 'microsoft basic', 'basic render', 'warp'];

/**
 * Se résout avec `promise`, ou rejette après `ms`. Une valeur arrivée en
 * retard est passée à `onLate` (par ex. un device à détruire).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(translateAppText('{{step}} sans réponse après {{seconds}} s', { step: label, seconds: Math.round(ms / 1000) })));
    }, ms);
    promise.then(
      (value) => {
        if (settled) {
          onLate?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requestHighPerformanceAdapter(): Promise<GPUAdapter | null> {
  return withTimeout(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), ADAPTER_TIMEOUT_MS, 'requestAdapter');
}

/** `isFallbackAdapter` est passé de l'adaptateur à `adapter.info` (Chrome 136+). */
function isFallbackAdapter(adapter: GPUAdapter): boolean {
  const legacy = (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  const info = (adapter as unknown as { info?: { isFallbackAdapter?: boolean } }).info;
  return legacy === true || info?.isFallbackAdapter === true;
}

export type PreflightResult =
  | { ok: true; vendor: string; arch: string; desc: string }
  | { ok: false; code: 'no-webgpu' | 'no-adapter' | 'fallback-adapter' | 'software-adapter'; detail: string };

/**
 * WebGPU peut-il faire tourner le viewer ici ? Pas d'API (Firefox sous Linux,
 * Safari < 26), pas d'adaptateur (Chrome sous Linux hors des GPU qu'il active,
 * pilote en liste noire, accélération matérielle désactivée), ou un adaptateur
 * logiciel : le backend WebGL 2 prend le relais.
 */
export async function preflightWebGPU(): Promise<PreflightResult> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { ok: false, code: 'no-webgpu', detail: translateAppText('navigator.gpu indisponible') };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await requestHighPerformanceAdapter();
  } catch (e: unknown) {
    return { ok: false, code: 'no-adapter', detail: (e as Error)?.message || translateAppText('requestAdapter a échoué') };
  }
  if (!adapter) {
    return { ok: false, code: 'no-adapter', detail: translateAppText('Aucun GPUAdapter retourné') };
  }
  if (isFallbackAdapter(adapter)) {
    return { ok: false, code: 'fallback-adapter', detail: translateAppText('Adapter logiciel (fallback) détecté') };
  }
  const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string; description?: string; device?: string } }).info ?? {};
  const vendor = String(info.vendor ?? '').toLowerCase();
  const arch = String(info.architecture ?? '').toLowerCase();
  const desc = String(info.description ?? info.device ?? '').toLowerCase();
  const haystack = `${vendor} ${arch} ${desc}`;
  if (SOFTWARE_ADAPTER_SIGNATURES.some((signature) => haystack.includes(signature))) {
    return {
      ok: false,
      code: 'software-adapter',
      detail: translateAppText('Adapter logiciel : {{name}}', { name: desc || vendor || '?' }),
    };
  }
  return { ok: true, vendor, arch, desc };
}

/**
 * Adaptateur + device haute performance (avec `timestamp-query` quand il est
 * proposé) et le profil de plateforme qui pilote le MSAA et le budget de points.
 */
export async function requestLidarGpu(): Promise<{ device: GPUDevice; profile: PlatformProfile }> {
  if (!navigator.gpu) throw new Error(translateAppText('WebGPU non supporté'));
  const adapter = await requestHighPerformanceAdapter();
  if (!adapter) throw new Error(translateAppText('Pas de GPUAdapter'));

  const platform = resolvePlatformInfo((adapter as { info?: GpuAdapterInfoFields }).info ?? null);
  const { vendor, arch, desc } = platform;
  const profile = fitProfileToMemory(platform.profile, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  console.log(`[LiDAR GPU] Adapter: vendor=${vendor} arch=${arch} desc=${desc}`);

  const features: GPUFeatureName[] = [];
  if (adapter.features.has('timestamp-query')) features.push('timestamp-query');

  const device = await withTimeout(
    adapter.requestDevice({ requiredFeatures: features }),
    DEVICE_TIMEOUT_MS,
    'requestDevice',
    (late) => late.destroy(),
  );
  device.addEventListener('uncapturederror', (event) => {
    console.error('[LiDAR GPU] Uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
  });
  return { device, profile };
}

/** Message de la surcouche du viewer après une perte du device GPU (la page doit être rechargée). */
export function showDeviceLostNotice(info: GPUDeviceLostInfo): void {
  const statusEl = document.getElementById('status');
  const overlay = document.getElementById('overlay');
  if (statusEl) statusEl.textContent = translateAppText('⚠️ Périphérique GPU perdu : {{reason}}. Rechargez la page.', { reason: info.message || info.reason });
  if (overlay) overlay.classList.remove('hidden');
}
