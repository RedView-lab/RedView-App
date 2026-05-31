import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Map as MapboxMap, MapboxGeoJSONFeature, MapMouseEvent, PointLike } from 'mapbox-gl';

import { OPENMETEO_FORECAST_URL } from '@/features/weather/lib/openMeteoConfig';
import { POI_LABELS, type PoiCategory } from '@/features/poi/types';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import { MenuActionRow } from './MenuActionRow';
import {
  ClockGlyph,
  CopyButtonIcon,
  ElevationGlyph,
  FinishGlyph,
  GlobeGlyph,
  PoiPinGlyph,
  SlopeGlyph,
  StartGlyph,
  SunGlyph,
  SurfaceGlyph,
  ThermometerGlyph,
  WaypointGlyph,
  WindGlyph,
} from './icons';
import type {
  MapContextMenuActionId,
  MapContextMenuActionPayload,
  MapContextMenuOverlayContext,
  MapContextMenuOverlayDetail,
  MapContextMenuPoint,
} from './types';
import { clamp, copyTextToClipboard, formatCoordinates } from './utils';

const MENU_EDGE_PADDING = 8;
const RIGHT_CLICK_MOVE_TOLERANCE_PX = 8;
const RIGHT_CLICK_MAX_HOLD_MS = 320;
const MENU_WIDTH = 200;

const FEATURE_CATEGORY_LABELS: Record<string, string> = {
  address: 'Adresse',
  bakery: POI_LABELS.bakery,
  bar: POI_LABELS.bar,
  bicycle: POI_LABELS.bicycle,
  bicycle_repair: POI_LABELS.bicycle_repair,
  cafe: POI_LABELS.cafe,
  camp_site: POI_LABELS.camp_site,
  convenience: POI_LABELS.convenience,
  drinking_water: POI_LABELS.drinking_water,
  fast_food: POI_LABELS.fast_food,
  fuel: POI_LABELS.fuel,
  hospital: POI_LABELS.hospital,
  hotel: POI_LABELS.hotel,
  pharmacy: POI_LABELS.pharmacy,
  place: 'Lieu',
  poi: 'POI',
  restaurant: POI_LABELS.restaurant,
  road: 'Route',
  shelter: POI_LABELS.shelter,
  supermarket: POI_LABELS.supermarket,
  toilets: POI_LABELS.toilets,
};

const SURFACE_LABELS: Record<string, string> = {
  asphalt: 'Bitume',
  asphalted: 'Bitume',
  chipseal: 'Bitume',
  cobblestone: 'Pavés',
  compacted: 'Compacté',
  concrete: 'Béton',
  dirt: 'Terre',
  fine_gravel: 'Gravier fin',
  grass: 'Herbe',
  gravel: 'Gravier',
  ground: 'Terre',
  metal: 'Métal',
  paved: 'Bitume',
  paving_stones: 'Pavés',
  pebblestone: 'Galets',
  rock: 'Roche',
  sand: 'Sable',
  sett: 'Pavés',
  unpaved: 'Non revêtu',
  wood: 'Bois',
};

function sampleSlopePct(map: MapboxMap, lng: number, lat: number): number | null {
  const elevation = map.queryTerrainElevation?.([lng, lat]);
  if (!Number.isFinite(elevation)) return null;

  const baseElevation = Number(elevation);
  const sampleDistanceM = 8;
  const delta = sampleDistanceM / 111_320;
  const elevN = map.queryTerrainElevation?.([lng, lat + delta]) ?? baseElevation;
  const elevS = map.queryTerrainElevation?.([lng, lat - delta]) ?? baseElevation;
  const elevE = map.queryTerrainElevation?.([lng + delta, lat]) ?? baseElevation;
  const elevW = map.queryTerrainElevation?.([lng - delta, lat]) ?? baseElevation;
  const slopeX = Math.abs(elevE - elevW) / (2 * sampleDistanceM);
  const slopeY = Math.abs(elevN - elevS) / (2 * sampleDistanceM);
  return Math.round(Math.hypot(slopeX, slopeY) * 100);
}

function getFeatureString(
  properties: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function humanizeToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\p{L}/gu, (match) => match.toLocaleUpperCase('fr-FR'));
}

function normalizeCategoryLabel(value: string | null): string | null {
  if (!value) return null;

  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized in POI_LABELS) {
    return POI_LABELS[normalized as PoiCategory];
  }

  return FEATURE_CATEGORY_LABELS[normalized] ?? humanizeToken(value);
}

function normalizeSurfaceLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  return SURFACE_LABELS[normalized] ?? humanizeToken(value);
}

function scoreFeature(feature: MapboxGeoJSONFeature): number {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const layerId = feature.layer?.id?.toLowerCase() ?? '';

  let score = 0;
  if (getFeatureString(properties, ['name_fr', 'name', 'name_en', 'ref'])) score += 100;
  if (getFeatureString(properties, ['category', 'class', 'subclass', 'maki', 'type', 'poi'])) score += 45;
  if (getFeatureString(properties, ['opening_hours', 'openingHours'])) score += 35;
  if (getFeatureString(properties, ['surface', 'road_surface'])) score += 25;
  if (feature.layer?.type === 'symbol') score += 10;
  if (layerId.includes('poi')) score += 24;
  if (layerId.includes('road')) score += 12;
  if (layerId.includes('place')) score += 8;
  return score;
}

function resolvePointContext(
  map: MapboxMap,
  point: PointLike,
): Pick<MapContextMenuPoint, 'title' | 'categoryLabel' | 'surfaceLabel' | 'openingHoursLabel'> {
  const features = map
    .queryRenderedFeatures(point)
    .filter((feature) => feature.layer?.type !== 'background');

  if (features.length === 0) {
    return {
      title: null,
      categoryLabel: null,
      surfaceLabel: null,
      openingHoursLabel: null,
    };
  }

  const feature = [...features].sort((left, right) => scoreFeature(right) - scoreFeature(left))[0];
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const name = getFeatureString(properties, ['name_fr', 'name', 'name_en', 'ref']);
  const categoryLabel = normalizeCategoryLabel(
    getFeatureString(properties, ['category', 'class', 'subclass', 'maki', 'type', 'poi']),
  );

  return {
    title: name ?? categoryLabel,
    categoryLabel,
    surfaceLabel: normalizeSurfaceLabel(getFeatureString(properties, ['surface', 'road_surface', 'piste:type'])),
    openingHoursLabel: getFeatureString(properties, ['opening_hours', 'openingHours']),
  };
}

interface MapContextMenuProps {
  map: MapboxMap | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onAction?: (payload: MapContextMenuActionPayload) => void;
  overlayContext?: MapContextMenuOverlayContext;
}

interface MenuState {
  left: number;
  top: number;
  screenX: number;
  screenY: number;
  point: MapContextMenuPoint;
}

interface PendingRightClickState {
  startedAtMs: number;
  startX: number;
  startY: number;
  moved: boolean;
  consumed: boolean;
}

interface ForecastPointResponse {
  hourly?: {
    temperature_2m?: Array<number | null>;
    relative_humidity_2m?: Array<number | null>;
    apparent_temperature?: Array<number | null>;
    precipitation?: Array<number | null>;
    cloud_cover?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
  };
  daily?: {
    sunrise?: string[];
    sunset?: string[];
  };
}

function formatTemperature(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}°C`;
}

function formatRain(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  if (Number(value) <= 0) return '0 mm';
  return `${Number(value).toFixed(Number(value) >= 10 ? 0 : 1)} mm`;
}

function formatHumidity(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}% humidité`;
}

function formatCloudCover(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}% nuages`;
}

function formatWindDirection(degrees: number): string {
  const headings = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % headings.length;
  return headings[index];
}

function formatWindLabel(speed: number | null | undefined, direction: number | null | undefined): string | null {
  if (!Number.isFinite(speed)) return null;
  const speedLabel = `${Math.round(Number(speed) * 3.6)} km/h`;
  if (!Number.isFinite(direction)) return speedLabel;
  return `${speedLabel} ${formatWindDirection(Number(direction))}`;
}

function formatIsoTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /T(\d{2}:\d{2})/.exec(value);
  return match ? match[1] : null;
}

function buildOverlayForecastUrl(
  lat: number,
  lng: number,
  overlayContext: MapContextMenuOverlayContext,
): string | null {
  const needsWeather = overlayContext.weather.enabled && overlayContext.weather.activeLayers.length > 0;
  const needsWind = overlayContext.wind.enabled && (overlayContext.wind.terrainOverlayEnabled || overlayContext.wind.particlesEnabled);
  const needsSunlight = overlayContext.sunlight.enabled && (overlayContext.sunlight.shadowEnabled || overlayContext.sunlight.sunlightMapEnabled);
  if (!needsWeather && !needsWind && !needsSunlight) return null;

  const date = overlayContext.weather.date || overlayContext.wind.date || overlayContext.sunlight.date;
  const time = overlayContext.weather.time || overlayContext.wind.time || overlayContext.sunlight.time;
  if (!date || !time) return null;

  const url = new URL(OPENMETEO_FORECAST_URL, window.location.origin);
  url.searchParams.set('latitude', lat.toFixed(6));
  url.searchParams.set('longitude', lng.toFixed(6));
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('cell_selection', 'nearest');
  url.searchParams.set('start_hour', `${date}T${time}`);
  url.searchParams.set('end_hour', `${date}T${time}`);

  const hourlyFields = new Set<string>();
  if (needsWeather) {
    hourlyFields.add('temperature_2m');
    hourlyFields.add('relative_humidity_2m');
    hourlyFields.add('apparent_temperature');
    hourlyFields.add('precipitation');
    hourlyFields.add('cloud_cover');
  }
  if (needsWind) {
    hourlyFields.add('wind_speed_10m');
    hourlyFields.add('wind_direction_10m');
  }
  if (hourlyFields.size > 0) {
    url.searchParams.set('hourly', [...hourlyFields].join(','));
  }
  if (needsSunlight) {
    url.searchParams.set('daily', 'sunrise,sunset');
    url.searchParams.set('forecast_days', '1');
  }

  return url.toString();
}

async function fetchOverlayDetails(
  lat: number,
  lng: number,
  overlayContext: MapContextMenuOverlayContext,
  signal: AbortSignal,
): Promise<MapContextMenuOverlayDetail[]> {
  const url = buildOverlayForecastUrl(lat, lng, overlayContext);
  if (!url) return [];

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Overlay point forecast failed with ${response.status}`);
  }

  const payload = await response.json() as ForecastPointResponse;
  const details: MapContextMenuOverlayDetail[] = [];

  if (overlayContext.sunlight.enabled && (overlayContext.sunlight.shadowEnabled || overlayContext.sunlight.sunlightMapEnabled)) {
    const sunrise = formatIsoTime(payload.daily?.sunrise?.[0]);
    const sunset = formatIsoTime(payload.daily?.sunset?.[0]);
    if (sunrise || sunset) {
      details.push({
        id: 'sunlight',
        kind: 'sunlight',
        icon: 'sun',
        label: [sunrise ? `Lever ${sunrise}` : null, sunset ? `Coucher ${sunset}` : null].filter(Boolean).join('  '),
      });
    }
  }

  if (overlayContext.weather.enabled && overlayContext.weather.activeLayers.length > 0) {
    const weatherLabel = overlayContext.weather.activeLayers
      .map((layer) => {
        switch (layer) {
          case 'temperature':
            return formatTemperature(payload.hourly?.temperature_2m?.[0]);
          case 'feelsLike':
            return payload.hourly?.apparent_temperature?.[0] == null
              ? null
              : `Ressenti ${formatTemperature(payload.hourly.apparent_temperature[0])}`;
          case 'rain':
            return formatRain(payload.hourly?.precipitation?.[0]);
          case 'cloudCover':
            return formatCloudCover(payload.hourly?.cloud_cover?.[0]);
          case 'humidity':
            return formatHumidity(payload.hourly?.relative_humidity_2m?.[0]);
          default:
            return null;
        }
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 2)
      .join('  ');

    if (weatherLabel) {
      details.push({
        id: 'weather',
        kind: 'weather',
        icon: 'thermometer',
        label: weatherLabel,
      });
    }
  }

  if (overlayContext.wind.enabled && (overlayContext.wind.terrainOverlayEnabled || overlayContext.wind.particlesEnabled)) {
    const windLabel = formatWindLabel(
      payload.hourly?.wind_speed_10m?.[0],
      payload.hourly?.wind_direction_10m?.[0],
    );
    if (windLabel) {
      details.push({
        id: 'wind',
        kind: 'wind',
        icon: 'wind',
        label: windLabel,
      });
    }
  }

  return details;
}

function OverlayDetailRow({ detail }: { detail: MapContextMenuOverlayDetail }) {
  const icon = detail.icon === 'sun'
    ? <SunGlyph />
    : detail.icon === 'thermometer'
      ? <ThermometerGlyph />
      : <WindGlyph />;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
      {icon}
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontWeight: 500,
          fontStyle: 'italic',
          lineHeight: '16px',
          color: '#ffffff',
        }}
      >
        {detail.label}
      </span>
    </div>
  );
}

export function MapContextMenu({ map, containerRef, onAction, overlayContext }: MapContextMenuProps) {
  const { t } = useAppI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const overlayAbortRef = useRef<AbortController | null>(null);
  const pendingRightClickRef = useRef<PendingRightClickState | null>(null);
  const [menuState, setMenuState] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);

  const closeMenu = useCallback(() => {
    setMenuState(null);
    setCopied(false);
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    overlayAbortRef.current?.abort();
    overlayAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (!map) return;

    const canvas = map.getCanvas();

    const resetPendingRightClick = () => {
      pendingRightClickRef.current = null;
    };

    const markPendingRightClickAsMoved = () => {
      const pending = pendingRightClickRef.current;
      if (!pending) return;
      pending.moved = true;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      pendingRightClickRef.current = {
        startedAtMs: performance.now(),
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        consumed: false,
      };
    };

    const handleMouseMove = (event: MouseEvent) => {
      const pending = pendingRightClickRef.current;
      if (!pending) return;

      const deltaX = event.clientX - pending.startX;
      const deltaY = event.clientY - pending.startY;
      if (Math.hypot(deltaX, deltaY) > RIGHT_CLICK_MOVE_TOLERANCE_PX) {
        pending.moved = true;
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const pending = pendingRightClickRef.current;
      if (!pending) return;
      if (pending.consumed || pending.moved) {
        pendingRightClickRef.current = null;
      }
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();

      const pending = pendingRightClickRef.current;
      const elapsedMs = pending ? performance.now() - pending.startedAtMs : Number.POSITIVE_INFINITY;
      const shouldOpenMenu = Boolean(
        pending
          && !pending.consumed
          && !pending.moved
          && elapsedMs <= RIGHT_CLICK_MAX_HOLD_MS,
      );

      pendingRightClickRef.current = null;
      if (!shouldOpenMenu || !pending) return;

      const container = containerRef.current;
      if (!container) return;

      const { lng, lat } = event.lngLat;
      const rect = container.getBoundingClientRect();
      const elevation = map.queryTerrainElevation?.([lng, lat]);
      const pointContext = resolvePointContext(map, event.point);

      setCopied(false);
      pending.consumed = true;
      setMenuState({
        left: event.originalEvent.clientX - rect.left,
        top: event.originalEvent.clientY - rect.top,
        screenX: event.originalEvent.clientX,
        screenY: event.originalEvent.clientY,
        point: {
          lng,
          lat,
          elevationMeters: Number.isFinite(elevation) ? Number(elevation) : null,
          slopePct: sampleSlopePct(map, lng, lat),
          coordinatesLabel: formatCoordinates(lat, lng),
          title: pointContext.title,
          categoryLabel: pointContext.categoryLabel,
          surfaceLabel: pointContext.surfaceLabel,
          openingHoursLabel: pointContext.openingHoursLabel,
          overlayDetails: [],
        },
      });
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', resetPendingRightClick);
    map.on('contextmenu', handleContextMenu);
    map.on('movestart', closeMenu);
    map.on('dragstart', closeMenu);
    map.on('pitchstart', closeMenu);
    map.on('rotatestart', closeMenu);
    map.on('movestart', markPendingRightClickAsMoved);
    map.on('dragstart', markPendingRightClickAsMoved);
    map.on('pitchstart', markPendingRightClickAsMoved);
    map.on('rotatestart', markPendingRightClickAsMoved);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', resetPendingRightClick);
      map.off('contextmenu', handleContextMenu);
      map.off('movestart', closeMenu);
      map.off('dragstart', closeMenu);
      map.off('pitchstart', closeMenu);
      map.off('rotatestart', closeMenu);
      map.off('movestart', markPendingRightClickAsMoved);
      map.off('dragstart', markPendingRightClickAsMoved);
      map.off('pitchstart', markPendingRightClickAsMoved);
      map.off('rotatestart', markPendingRightClickAsMoved);
    };
  }, [closeMenu, containerRef, map]);

  useLayoutEffect(() => {
    if (!menuState || !menuRef.current || !containerRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const nextLeft = clamp(
      menuState.left,
      MENU_EDGE_PADDING,
      Math.max(MENU_EDGE_PADDING, containerRect.width - menuRect.width - MENU_EDGE_PADDING),
    );
    const nextTop = clamp(
      menuState.top,
      MENU_EDGE_PADDING,
      Math.max(MENU_EDGE_PADDING, containerRect.height - menuRect.height - MENU_EDGE_PADDING),
    );

    if (nextLeft !== menuState.left || nextTop !== menuState.top) {
      setMenuState((current) => {
        if (!current) return current;
        if (current.left === nextLeft && current.top === nextTop) return current;
        return { ...current, left: nextLeft, top: nextTop };
      });
    }
  }, [containerRef, menuState]);

  const activePoint = menuState?.point ?? null;

  useEffect(() => {
    if (!activePoint || !overlayContext) return;

    const { lat, lng } = activePoint;

    const controller = new AbortController();
    overlayAbortRef.current?.abort();
    overlayAbortRef.current = controller;

    void fetchOverlayDetails(lat, lng, overlayContext, controller.signal)
      .then((overlayDetails) => {
        if (controller.signal.aborted) return;
        setMenuState((current) => {
          if (!current) return current;
          if (current.point.lat !== lat || current.point.lng !== lng) {
            return current;
          }
          return {
            ...current,
            point: {
              ...current.point,
              overlayDetails,
            },
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
      });

    return () => {
      controller.abort();
      if (overlayAbortRef.current === controller) {
        overlayAbortRef.current = null;
      }
    };
  }, [activePoint, overlayContext]);

  useEffect(() => {
    if (!menuState) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    const handleWindowChange = () => closeMenu();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('blur', handleWindowChange);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('blur', handleWindowChange);
    };
  }, [closeMenu, menuState]);

  const emitAction = useCallback((action: MapContextMenuActionId) => {
    if (!menuState) return;
    onAction?.({
      action,
      point: menuState.point,
      screenPoint: {
        x: menuState.screenX,
        y: menuState.screenY,
      },
    });
  }, [menuState, onAction]);

  const handleCopyCoordinates = useCallback(async () => {
    if (!menuState) return;
    try {
      await copyTextToClipboard(menuState.point.coordinatesLabel);
      emitAction('copy-coordinates');
      setCopied(true);
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = null;
      }, 1200);
    } catch {
      emitAction('copy-coordinates');
    }
  }, [emitAction, menuState]);

  useEffect(() => () => {
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const elevationLabel = useMemo(() => {
    if (!menuState) return null;
    if (menuState.point.elevationMeters == null) return '...';
    return `${Math.round(menuState.point.elevationMeters)}m`;
  }, [menuState]);

  const slopeLabel = useMemo(() => {
    if (!menuState) return null;
    if (menuState.point.slopePct == null) return null;
    return `${Math.abs(menuState.point.slopePct)}%`;
  }, [menuState]);

  const titleLabel = menuState?.point.title?.trim() || t('Point sélectionné');
  const categoryLabel = menuState?.point.categoryLabel?.trim() || t('Position');

  const handleOpenStreetView = useCallback(() => {
    if (!menuState) return;

    const { lat, lng } = menuState.point;
    const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(`${lat},${lng}`)}`;
    window.open(streetViewUrl, '_blank', 'noopener,noreferrer');
  }, [menuState]);

  if (!menuState) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('Menu contextuel de la carte')}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: 'absolute',
        top: menuState.top,
        left: menuState.left,
        zIndex: 34,
        width: MENU_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.08)',
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        borderBottomLeftRadius: 0,
        boxShadow: '0 12px 36px rgba(0,0,0,0.38)',
        color: '#ffffff',
        fontFamily: 'Rethink Sans, system-ui, -apple-system, Segoe UI, sans-serif',
      }}
    >
      <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.74)" />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 32 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            color: '#ffffff',
            flex: '0 0 auto',
          }}
        >
          <SvgV2Icon name="star-01.svg" size={16} />
        </span>

        <span
          style={{
            minWidth: 0,
            flex: '1 1 0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 500,
            lineHeight: '17px',
            color: '#ffffff',
          }}
        >
          {titleLabel}
        </span>

        <button
          type="button"
          onClick={handleOpenStreetView}
          aria-label={t('Ouvrir Street View')}
          title={t('Ouvrir Street View')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.92)',
            cursor: 'pointer',
            flex: '0 0 auto',
          }}
        >
          <GlobeGlyph />
        </button>
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, paddingBlock: 4 }}>
          <span
            style={{
              minWidth: 0,
              flex: '0 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 500,
              fontStyle: 'italic',
              lineHeight: '16px',
              color: '#ffffff',
            }}
          >
            {categoryLabel}
          </span>

          <span
            style={{
              minWidth: 0,
              flex: '1 1 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 500,
              fontStyle: 'italic',
              lineHeight: '16px',
              color: '#ffffff',
            }}
          >
            {menuState.point.coordinatesLabel}
          </span>

          <button
            type="button"
            onClick={() => {
              void handleCopyCoordinates();
            }}
            aria-label={t('Copier les coordonnées')}
            title={t('Copier les coordonnées')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.92)',
              cursor: 'pointer',
            }}
          >
            <CopyButtonIcon copied={copied} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
          {slopeLabel ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <SlopeGlyph />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  fontStyle: 'italic',
                  lineHeight: '16px',
                  color: '#ffffff',
                }}
              >
                {slopeLabel}
              </span>
            </div>
          ) : null}

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <ElevationGlyph />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                fontStyle: 'italic',
                lineHeight: '16px',
                color: '#ffffff',
              }}
            >
              {elevationLabel}
            </span>
          </div>

          {menuState.point.surfaceLabel ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <SurfaceGlyph />
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  fontWeight: 500,
                  fontStyle: 'italic',
                  lineHeight: '16px',
                  color: '#ffffff',
                }}
              >
                {menuState.point.surfaceLabel}
              </span>
            </div>
          ) : null}
        </div>

        {menuState.point.openingHoursLabel ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 24 }}>
            <ClockGlyph />
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                fontWeight: 500,
                fontStyle: 'italic',
                lineHeight: '16px',
                color: '#ffffff',
              }}
            >
              {menuState.point.openingHoursLabel}
            </span>
          </div>
        ) : null}

        {menuState.point.overlayDetails.map((detail) => (
          <OverlayDetailRow key={detail.id} detail={detail} />
        ))}
      </div>

      <div
        aria-hidden
        style={{
          position: 'relative',
          width: '100%',
          height: 1,
          background: 'rgba(255,255,255,0.12)',
        }}
      />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <MenuActionRow
          label={t('Créer un POI')}
          icon={<PoiPinGlyph />}
          onClick={() => {
            emitAction('create-poi');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Démarrer ici')}
          icon={<StartGlyph />}
          onClick={() => {
            emitAction('set-start');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Ajouter une étape')}
          icon={<WaypointGlyph />}
          onClick={() => {
            emitAction('add-waypoint');
            closeMenu();
          }}
        />
        <MenuActionRow
          label={t('Finir ici')}
          icon={<FinishGlyph />}
          onClick={() => {
            emitAction('set-finish');
            closeMenu();
          }}
        />
      </div>
    </div>
  );
}