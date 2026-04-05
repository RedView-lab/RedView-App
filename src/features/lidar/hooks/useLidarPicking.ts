import { useEffect, useRef, useState, useCallback } from 'react';
import type { Map as MapboxMap, MapMouseEvent, GeoJSONSource } from 'mapbox-gl';
import type { TileCoord } from '../types/geometry';
import type { DownloadProgress } from '../types/events';
import type { CachedTileInfo } from '../types/tile';
import { fromWgs84, detectAltRef } from '../processing/coord-transform';
import { tileToGeoJsonFeature } from '../tile-manager/tile-grid';
import { downloadTile } from '../api/ign-download';
import { listCachedTiles, deleteTile as deleteTileFromStore } from '../storage/tile-store';

const HOVER_SOURCE = 'lidar-hover-tile';
const HOVER_FILL = 'lidar-hover-fill';
const HOVER_LINE = 'lidar-hover-line';

export interface PickingState {
  isPicking: boolean;
  pendingCoord: TileCoord | null;
  clickScreenPos: { x: number; y: number } | null;
  downloading: TileCoord | null;
  progress: DownloadProgress | null;
  cachedTiles: CachedTileInfo[];
  startPicking: () => void;
  stopPicking: () => void;
  confirmDownload: () => void;
  cancelPending: () => void;
  deleteTile: (coord: TileCoord) => void;
  refreshCache: () => void;
}

function wgs84ToTileCoord(lng: number, lat: number): TileCoord {
  const [x, y] = fromWgs84(lng, lat, 'LAMB93');
  const xKm = Math.floor(x / 1000);
  const yKm = Math.floor(y / 1000);
  const altRef = detectAltRef('LAMB93', xKm * 1000 + 500, yKm * 1000 + 500);
  return { xKm, yKm, territory: 'FXX', projection: 'LAMB93', altRef };
}

function tilePolygonGeoJson(coord: TileCoord): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [tileToGeoJsonFeature(coord, 'hover')],
  };
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function useLidarPicking(map: MapboxMap | null): PickingState {
  const [isPicking, setIsPicking] = useState(false);
  const [pendingCoord, setPendingCoord] = useState<TileCoord | null>(null);
  const [clickScreenPos, setClickScreenPos] = useState<{ x: number; y: number } | null>(null);
  const [downloading, setDownloading] = useState<TileCoord | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);

  const pickingRef = useRef(false);
  const pendingRef = useRef<TileCoord | null>(null);

  // Sync refs with state for closures
  useEffect(() => { pickingRef.current = isPicking; }, [isPicking]);
  useEffect(() => { pendingRef.current = pendingCoord; }, [pendingCoord]);

  // Load cached tiles on mount
  const refreshCache = useCallback(() => {
    listCachedTiles().then(setCachedTiles).catch(() => {});
  }, []);

  useEffect(() => { refreshCache(); }, [refreshCache]);

  // Setup map layers for hover overlay
  useEffect(() => {
    if (!map) return;

    const setupOverlay = () => {
      if (map.getSource(HOVER_SOURCE)) return;

      map.addSource(HOVER_SOURCE, {
        type: 'geojson',
        data: EMPTY_FC,
      });

      map.addLayer({
        id: HOVER_FILL,
        type: 'fill',
        source: HOVER_SOURCE,
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.25,
        },
      });

      map.addLayer({
        id: HOVER_LINE,
        type: 'line',
        source: HOVER_SOURCE,
        paint: {
          'line-color': '#ef4444',
          'line-width': 2,
          'line-dasharray': [2, 2],
        },
      });
    };

    if (map.isStyleLoaded()) {
      setupOverlay();
    } else {
      map.on('style.load', setupOverlay);
    }

    return () => {
      map.off('style.load', setupOverlay);
      if (map.getLayer(HOVER_LINE)) map.removeLayer(HOVER_LINE);
      if (map.getLayer(HOVER_FILL)) map.removeLayer(HOVER_FILL);
      if (map.getSource(HOVER_SOURCE)) map.removeSource(HOVER_SOURCE);
    };
  }, [map]);

  // Mouse move — show hover tile while picking
  useEffect(() => {
    if (!map) return;

    const onMouseMove = (e: MapMouseEvent) => {
      if (!pickingRef.current || pendingRef.current) return;
      const coord = wgs84ToTileCoord(e.lngLat.lng, e.lngLat.lat);
      const source = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined;
      if (source) {
        source.setData(tilePolygonGeoJson(coord));
      }
    };

    map.on('mousemove', onMouseMove);
    return () => { map.off('mousemove', onMouseMove); };
  }, [map]);

  // Click — lock a tile for confirmation
  useEffect(() => {
    if (!map) return;

    const onClick = (e: MapMouseEvent) => {
      if (!pickingRef.current || pendingRef.current) return;
      const coord = wgs84ToTileCoord(e.lngLat.lng, e.lngLat.lat);
      setPendingCoord(coord);
      setClickScreenPos({ x: e.point.x, y: e.point.y });

      // Lock overlay to this tile
      const source = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined;
      if (source) {
        source.setData(tilePolygonGeoJson(coord));
      }
    };

    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [map]);

  // Manage cursor while picking
  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    if (isPicking && !pendingCoord) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
    return () => { canvas.style.cursor = ''; };
  }, [map, isPicking, pendingCoord]);

  const startPicking = useCallback(() => {
    setIsPicking(true);
    setPendingCoord(null);
    setClickScreenPos(null);
  }, []);

  const stopPicking = useCallback(() => {
    setIsPicking(false);
    setPendingCoord(null);
    setClickScreenPos(null);
    // Clear hover overlay
    if (map) {
      const source = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined;
      source?.setData(EMPTY_FC);
    }
  }, [map]);

  const cancelPending = useCallback(() => {
    setPendingCoord(null);
    setClickScreenPos(null);
    // Keep picking mode, clear locked overlay, let hover resume
  }, []);

  const confirmDownload = useCallback(async () => {
    const coord = pendingRef.current;
    if (!coord) return;

    setPendingCoord(null);
    setClickScreenPos(null);
    setIsPicking(false);

    // Clear hover overlay
    if (map) {
      const source = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined;
      source?.setData(EMPTY_FC);
    }

    setDownloading(coord);
    setProgress(null);

    try {
      await downloadTile(coord, (p) => {
        setProgress(p);
      });
      refreshCache();
    } catch (err) {
      console.error('[lidar] Download failed:', err);
    } finally {
      setDownloading(null);
      setProgress(null);
    }
  }, [map, refreshCache]);

  const removeTile = useCallback(async (coord: TileCoord) => {
    await deleteTileFromStore(coord);
    refreshCache();
  }, [refreshCache]);

  return {
    isPicking,
    pendingCoord,
    clickScreenPos,
    downloading,
    progress,
    cachedTiles,
    startPicking,
    stopPicking,
    confirmDownload,
    cancelPending,
    deleteTile: removeTile,
    refreshCache,
  };
}
