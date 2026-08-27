export { LidarManager } from './lib/lidarManager';
export type {
  TileCoord, DownloadProgress, LidarEvent,
  LidarEventCallback, CachedTileInfo, PointCloudData,
  DetectedCrs, AltitudeRef, PointCloudBounds,
} from './types';
export {
  buildTileFileName,
  loadLidarTileLabels,
  setLidarTileLabel,
  syncLidarRouteOverlay,
  broadcastLidarRouteEdit,
  loadLidarRouteOverlay,
  subscribeToLidarRouteOverlay,
  useLidarRouteSync,
  extractLidarRouteOverlayState,
  LIDAR_ROUTE_OVERLAY_STORAGE_KEY,
  LIDAR_ROUTE_OVERLAY_CHANNEL_NAME,
  type LidarRouteOverlayItem,
  type LidarRouteOverlayPoint,
  type LidarRouteOverlayState,
  type LidarRouteSyncMessage,
  type LidarRouteEditMessage,
  toWgs84,
  wgs84ToTileCoord,
} from './lib';
export { LidarProvider, useLidarManager } from './components/LidarContext';
