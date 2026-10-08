import { translateAppText } from '@/shared/i18n/config';
import type { SceneLodStats } from '../lod/sceneLod';
import type { RestRefinement } from '../lod/restRefinement';
import type { PlatformProfile } from '../lod/types';
import type { LidarRenderer } from '../renderer/sceneRenderer';
import type { FrameClock } from './frameClock';

export interface LodStatsLineInput {
  lodStats: SceneLodStats;
  frameClock: FrameClock;
  renderer: LidarRenderer | null;
  /** Temps CPU de la dernière image (ms). */
  cpuFrameMs: number;
  restRefinement: RestRefinement;
  photoActive: boolean;
  tileCount: number;
  canvasWidth: number;
  canvasHeight: number;
  /** « WebGPU » ou « WebGL 2 ». */
  backendLabel: string;
  platformTier: PlatformProfile['tier'];
}

function cloudStats(renderer: LidarRenderer | null): string {
  const ms = renderer?.photo?.getCloudMs() ?? 0;
  return ms >= 0.05 ? ` · ${translateAppText('nuages {{ms}} ms', { ms: ms.toFixed(1) })}` : '';
}

/** La ligne de statistiques détaillées du viewer (la touche Q l'affiche ou la masque). */
export function formatLodStatsLine(input: LodStatsLineInput): string {
  const { lodStats, renderer, restRefinement } = input;
  const cadence = input.frameClock.getCadence();
  const gpuMs = renderer?.getGpuFrameMs() ?? 0;
  const shadeMs = renderer?.getGpuShadeMs() ?? 0;
  const renderStats = renderer?.getLastRenderStats();
  const drawCalls = renderStats?.drawCalls ?? 0;
  const terrainTriangles = renderStats?.terrainTriangles ?? 0;
  const renderScale = renderer?.getLastRenderScale() ?? 1;
  return (cadence.samples > 0 ? `${cadence.fps} fps · p95 ${cadence.p95Ms.toFixed(0)} ms` : '— fps') +
    (gpuMs > 0 ? ` · GPU ${gpuMs.toFixed(1)} ms` : '') +
    (shadeMs >= 0.05 ? ` + ${translateAppText('ombrage {{ms}} ms', { ms: shadeMs.toFixed(1) })}` : '') +
    ` · CPU ${input.cpuFrameMs.toFixed(1)} ms` +
    ` · ${lodStats.selectedPoints.toLocaleString()} / ${lodStats.totalPoints.toLocaleString()} pts` +
    ` · budget ${(lodStats.pointBudget / 1e6).toFixed(1)}M` +
    ` · ${lodStats.selectedNodes}/${lodStats.totalNodes} nodes · draws ${drawCalls}` +
    (terrainTriangles > 0 ? ` · terrain ${(terrainTriangles / 1e6).toFixed(2)}M △` : '') +
    ` · GPU ${(lodStats.residentPoints / 1e6).toFixed(1)}/${(lodStats.poolBudget / 1e6).toFixed(0)}M pts` +
    (lodStats.pendingLoads > 0 ? ` · ${translateAppText('chargement {{count}}', { count: lodStats.pendingLoads })}` : '') +
    (restRefinement.phase === 'refine'
      ? ` · ${translateAppText('affinage')}`
      : restRefinement.phase === 'accumulate'
        ? ` · ${translateAppText('lissage {{done}}/{{total}}', { done: restRefinement.sample, total: restRefinement.samples })}`
        : '') +
    (input.photoActive ? ` · ${translateAppText('mode photo')}${cloudStats(renderer)}` : '') +
    ` · ${translateAppText('{{count}} tuile(s)', { count: input.tileCount })}` +
    ` · ${input.canvasWidth}×${input.canvasHeight}${renderScale < 1 ? ` ×${renderScale.toFixed(2)}` : ''} ${input.backendLabel} ${input.platformTier}`;
}
