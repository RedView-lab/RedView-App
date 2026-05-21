export { useSunlight } from './hooks/useSunlight';
export type { UseSunlightOptions, UseSunlightResult } from './hooks/useSunlight';
export { useShadowImage } from './hooks/useShadowImage';
export type { UseShadowImageOptions } from './hooks/useShadowImageShared';
export { getSunPosition, getSunTimes, formatHHmm, resolveSunTimesForLocalDay } from './lib/sun-calc';
export type { ResolvedSunTimes, SunPosition, SunTimes } from './lib/sun-calc';
export type {
	SunlightLegendBandContract,
	SunlightMapComputationRequest,
	SunlightTrajectoryComputationRequest,
	SunlightTrajectorySample,
} from './lib/trajectory-contract';
export { SUN_DISK_LAYER_ID, addSunDiskLayer, removeSunDiskLayer, updateSunDiskPosition } from './lib/sun-disk-layer';
export { SUN_RAY_LAYER_ID, addSunRayLayer, removeSunRayLayer, updateSunRayPosition } from './lib/sun-ray/sun-ray-layer';
