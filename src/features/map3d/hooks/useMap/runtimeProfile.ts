import type { Map as MapboxMap } from 'mapbox-gl';
import { DEFAULT_ORTHO_BOOT_FALLBACK_MS } from './constants';

export interface MapRuntimeProfile {
  antialias: boolean;
  pixelRatio: number;
  minTileCacheSize: number;
  maxTileCacheSize: number;
  orthoBootFallbackMs: number;
}

interface GpuProfile {
  isIntegratedGpu: boolean;
  isAmdOrIntel: boolean;
  isAppleGpu: boolean;
}

const UNKNOWN_GPU: GpuProfile = { isIntegratedGpu: false, isAmdOrIntel: false, isAppleGpu: false };
let cachedGpuProfile: GpuProfile | null = null;

function detectGpuProfile(): GpuProfile {
  if (cachedGpuProfile) return cachedGpuProfile;
  if (typeof document === 'undefined') return UNKNOWN_GPU;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return UNKNOWN_GPU;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
    // Libère tout de suite le contexte de sonde : les navigateurs plafonnent le
    // nombre de contextes WebGL vivants (Safari ~16) et un contexte orphelin garde
    // de la mémoire GPU jusqu'au ramasse-miettes.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const r = renderer.toLowerCase();

    // Detect integrated GPUs (AMD Radeon Graphics / 680M / 780M / 880M, Intel Iris / UHD / Arc iGPU,
    // Apple Silicon: "ANGLE Metal Renderer: Apple M..." in Chromium, masked "Apple GPU" in Safari), mobile GPUs
    const isAmdOrIntel = /radeon|amd|intel/.test(r);
    const isAppleGpu = /apple m|apple gpu/.test(r);
    const isDedicated = /geforce|rtx|gtx|quadro|titan|radeon rx (?:[56789]\d00|vega (?:56|64))/.test(r);
    const isIntegrated = (isAmdOrIntel && !isDedicated) || isAppleGpu || /mali|adreno|powervr|swiftshader/.test(r);
    cachedGpuProfile = { isIntegratedGpu: isIntegrated, isAmdOrIntel, isAppleGpu };
    return cachedGpuProfile;
  } catch {
    return UNKNOWN_GPU;
  }
}

export function getMapRuntimeProfile(): MapRuntimeProfile {
  const nav = navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      saveData?: boolean;
    };
    deviceMemory?: number;
    userAgentData?: {
      mobile?: boolean;
    };
  };

  const ua = (nav.userAgent || '').toLowerCase();
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
  const cores = nav.hardwareConcurrency || 0;
  const effectiveType = nav.connection?.effectiveType ?? '';
  const saveData = !!nav.connection?.saveData;
  const isMobile = !!nav.userAgentData?.mobile || /android|iphone|ipad|ipod|mobile/.test(ua);
  const { isIntegratedGpu, isAppleGpu } = detectGpuProfile();

  const constrainedDevice = saveData
    || effectiveType === 'slow-2g'
    || effectiveType === '2g'
    || isMobile
    || (mem > 0 && mem <= 4)
    || (cores > 0 && cores <= 4);
  if (constrainedDevice) {
    return {
      antialias: false,
      pixelRatio: 1.0,
      minTileCacheSize: 240,
      maxTileCacheSize: 800,
      orthoBootFallbackMs: 2400,
    };
  }

  const balancedDevice = effectiveType === '3g'
    || isIntegratedGpu
    || (mem > 0 && mem <= 8)
    || (cores > 0 && cores <= 8);
  if (balancedDevice) {
    // Les GPU intégrés (p. ex. APU AMD Ryzen avec Radeon 780M / 680M) partagent la mémoire système (UMA).
    // Désactiver le MSAA 4x et plafonner le DPR à 1,25 économise plus de 60 % de débit de remplissage en gardant un rendu net.
    return {
      antialias: false,
      // Apple Silicon Retina: 1.5 on-screen density (true on-screen, see setDprLayoutScale).
      pixelRatio: isAppleGpu ? 1.5 : 1.25,
      minTileCacheSize: 320,
      maxTileCacheSize: 1000,
      orthoBootFallbackMs: 1800,
    };
  }

  return {
    antialias: true,
    pixelRatio: 1.5,
    minTileCacheSize: 400,
    maxTileCacheSize: 1200,
    orthoBootFallbackMs: DEFAULT_ORTHO_BOOT_FALLBACK_MS,
  };
}

let dprPatched = false;
let dprCap = Number.POSITIVE_INFINITY;
let dprLayoutScale = 1;
let dprOverride: number | null = null;
let readNativeDpr: () => number = () => 1;

function resolveNativeDprGetter(): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'devicePixelRatio');
  const getter = descriptor?.get;
  if (getter) return () => Number(getter.call(window)) || 1;
  const fixed = Number(window.devicePixelRatio) || 1;
  return () => fixed;
}

/**
 * Garantit que Mapbox GL JS (et chaque canvas du dashboard) rend au rapport de
 * pixels optimal pour le profil matériel de la machine.
 *
 * Mapbox GL JS n'accepte pas d'option `pixelRatio` au constructeur et lit
 * directement `window.devicePixelRatio` via son utilitaire navigateur interne.
 * Redéfinir l'accesseur avant `new mapboxgl.Map()` garantit que le
 * dimensionnement du canvas, les viewports du peintre, les matrices de
 * projection et les uniformes des shaders restent synchronisés.
 *
 * L'accesseur est dynamique : il suit le DPR natif (fenêtre déplacée d'un écran
 * à l'autre), applique le plafond du profil et compense l'échelle du canvas du
 * dashboard (`zoom: appScale` en CSS, voir {@link setDprLayoutScale}), pour que
 * des canvas dimensionnés en px logiques soient rendus à la résolution de
 * l'écran. Mapbox dimensionne son canvas dans ces px logiques
 * (lib/mapContainerZoom.ts).
 */
export function applyRuntimeProfileDpr(profile: MapRuntimeProfile): void {
  if (typeof window === 'undefined') return;
  dprCap = profile.pixelRatio;
  patchDevicePixelRatio();
}

function patchDevicePixelRatio(): boolean {
  if (dprPatched) return true;
  try {
    readNativeDpr = resolveNativeDprGetter();
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => dprOverride ?? Math.max(0.5, Math.min(readNativeDpr(), dprCap) * dprLayoutScale),
      configurable: true,
    });
    dprPatched = true;
  } catch (error) {
    console.warn('[runtimeProfile] Failed to cap window.devicePixelRatio', error);
  }
  return dprPatched;
}

/**
 * Exécute `fn` avec `window.devicePixelRatio` forcé à `dpr`, de façon synchrone.
 * Mapbox n'a qu'un seul rapport de pixels pour toutes les cartes de la page : la
 * carte hors écran de l'export vidéo du survol (rendue en 2× pendant que la carte
 * du dashboard garde celui du profil) enveloppe dans cette fonction son propre
 * rendu, sa construction et ses requêtes de tuiles ; rien d'autre ne voit le
 * forçage. Sans le correctif de l'accesseur, `fn` s'exécute simplement au
 * rapport courant.
 */
export function withDevicePixelRatio<T>(dpr: number, fn: () => T): T {
  if (typeof window === 'undefined' || !patchDevicePixelRatio()) return fn();
  const previous = dprOverride;
  dprOverride = dpr;
  try {
    return fn();
  } finally {
    dprOverride = previous;
  }
}

/**
 * Déclare l'échelle CSS appliquée au canvas du dashboard (`appScale`).
 * Une boîte de mise en page de W px logiques s'affiche sur W * appScale px
 * d'écran : le tampon n'a besoin que de `W * appScale * dpr` pixels. Par px
 * d'écran, il garde donc le DPR (plafonné) du profil quelle que soit l'échelle
 * du canvas. Prend effet au prochain redimensionnement du canvas (Mapbox se
 * redimensionne avec son conteneur).
 */
export function setDprLayoutScale(scale: number): void {
  dprLayoutScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function waitForMapIdleOrTimeout(map: MapboxMap, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.off('idle', onIdle);
      resolve();
    };
    const onIdle = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    map.on('idle', onIdle);
  });
}