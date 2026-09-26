import type { Map as MapboxMap } from 'mapbox-gl';

const EARTH_R_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Calcule la distance géodésique (en km) entre deux points de coordonnées WGS84.
 */
export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_R_KM * c;
}

/**
 * Calcule une durée de vol adaptée à la distance pour garantir une animation
 * fluide, naturelle et professionnelle, même à l'autre bout du monde.
 */
export function computeAdaptiveFlightDuration(distKm: number): number {
  if (!Number.isFinite(distKm) || distKm < 0.2) return 650;
  if (distKm < 2) return 850;
  if (distKm < 15) return 1100;
  if (distKm < 80) return 1400;
  if (distKm < 400) return 1750;
  if (distKm < 2000) return 2150;
  return 2600; // Vol intercontinental ("à l'autre bout du monde")
}

export interface MapViewportPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Calcule le padding réel du viewport de la carte 3D en tenant compte des panneaux
 * ouverts (panneau central d'analyse/tableau en bas, feuille de route à gauche,
 * réglages à droite, barre de recherche en haut).
 *
 * Cela garantit que la cible (point ou zone sélectionnée) est VRAIMENT bien centrée
 * dans l'espace utile et visible de la carte, et jamais masquée sous le tableau.
 */
export function getMapViewportPadding(map: MapboxMap): MapViewportPadding {
  try {
    const container = map.getContainer();
    if (!container) {
      return { top: 48, bottom: 280, left: 340, right: 340 };
    }
    const cRect = container.getBoundingClientRect();
    if (cRect.width <= 0 || cRect.height <= 0) {
      return { top: 48, bottom: 280, left: 340, right: 340 };
    }

    let left = 28;
    let right = 28;
    let top = 48;
    let bottom = 32;

    // Volet gauche (Feuille de route / ItineraryPanel)
    const leftPanel = (document.querySelector('.rv-itinerary-panel-shell, .rvi-shell') ??
      document.querySelector('[data-panel="left"]')) as HTMLElement | null;
    if (leftPanel) {
      const lRect = leftPanel.getBoundingClientRect();
      if (lRect.right > cRect.left && lRect.left < cRect.left + cRect.width / 2) {
        const visibleWidth = Math.min(lRect.right - cRect.left, cRect.width * 0.45);
        if (visibleWidth > 40) {
          left = Math.max(left, Math.round(visibleWidth + 24));
        }
      }
    }

    // Volet droit (ControlPanel / Exporter)
    const rightPanel = (document.querySelector('.rv-control-panel, .rvi-right-panel') ??
      document.querySelector('[data-panel="right"]')) as HTMLElement | null;
    if (rightPanel) {
      const rRect = rightPanel.getBoundingClientRect();
      if (rRect.left < cRect.right && rRect.right > cRect.right - cRect.width / 2) {
        const visibleWidth = Math.min(cRect.right - rRect.left, cRect.width * 0.45);
        if (visibleWidth > 40) {
          right = Math.max(right, Math.round(visibleWidth + 24));
        }
      }
    }

    // Panneau central / Tableau d'analyse & Toolbar en bas
    const centerPanel = document.querySelector('.rvc-center-panel') as HTMLElement | null;
    const centerToolbar = document.querySelector('.rvc-center-toolbar') as HTMLElement | null;
    if (centerPanel) {
      const pRect = centerPanel.getBoundingClientRect();
      if (pRect.top < cRect.bottom && pRect.bottom > cRect.top + cRect.height / 3) {
        const visibleHeight = Math.min(cRect.bottom - pRect.top, cRect.height * 0.65);
        if (visibleHeight > 40) {
          bottom = Math.max(bottom, Math.round(visibleHeight + 32));
        }
      }
    } else if (centerToolbar) {
      const tRect = centerToolbar.getBoundingClientRect();
      if (tRect.top < cRect.bottom) {
        const visibleHeight = Math.min(cRect.bottom - tRect.top, cRect.height * 0.35);
        if (visibleHeight > 20) {
          bottom = Math.max(bottom, Math.round(visibleHeight + 24));
        }
      }
    }

    // Contrôles supérieurs (Recherche dashboard / Header)
    const topBar = document.querySelector('.rv-dashboard-place-search, .dashboard-header') as HTMLElement | null;
    if (topBar) {
      const bRect = topBar.getBoundingClientRect();
      if (bRect.bottom > cRect.top) {
        top = Math.max(top, Math.round(bRect.bottom - cRect.top + 20));
      }
    }

    // Sécurité : borner le padding pour toujours laisser au moins 120px de zone utile
    const maxHoriz = Math.max(20, cRect.width - 120);
    if (left + right > maxHoriz) {
      const scale = maxHoriz / (left + right);
      left = Math.round(left * scale);
      right = Math.round(right * scale);
    }
    const maxVert = Math.max(20, cRect.height - 120);
    if (top + bottom > maxVert) {
      const scale = maxVert / (top + bottom);
      top = Math.round(top * scale);
      bottom = Math.round(bottom * scale);
    }

    return { top, bottom, left, right };
  } catch {
    return { top: 48, bottom: 280, left: 340, right: 340 };
  }
}

export interface FlyToLocationOptions {
  zoom?: number;
  pitch?: number;
  bearing?: number;
  duration?: number;
  padding?: MapViewportPadding;
}

/**
 * Centre la vue de manière fluide et professionnelle sur une coordonnée cible,
 * avec prise en compte du padding d'interface (panneau central, latéraux, etc.)
 * et trajectoire parabolique naturelle quel que soit l'éloignement.
 */
export function flyToLocation(
  map: MapboxMap | null | undefined,
  target: { lon: number; lat: number },
  options?: FlyToLocationOptions,
): void {
  if (!map || !Number.isFinite(target.lon) || !Number.isFinite(target.lat)) return;

  try {
    const currentCenter = map.getCenter();
    const currentPitch = map.getPitch();
    const distKm = haversineDistanceKm(currentCenter.lat, currentCenter.lng, target.lat, target.lon);

    const duration = options?.duration ?? computeAdaptiveFlightDuration(distKm);
    const padding = options?.padding ?? getMapViewportPadding(map);

    const is2D = currentPitch <= 8;
    const targetPitch = options?.pitch ?? (is2D ? 0 : Math.max(currentPitch, 58));
    const targetZoom = options?.zoom ?? Math.max(map.getZoom(), 15.4);

    map.flyTo({
      center: [target.lon, target.lat],
      zoom: targetZoom,
      pitch: targetPitch,
      bearing: options?.bearing ?? map.getBearing(),
      duration,
      curve: 1.42,
      speed: 1.2,
      padding,
      essential: true,
    });
  } catch {
    /* noop */
  }
}

export interface FlyToBoundsOptions {
  maxZoom?: number;
  pitch?: number;
  bearing?: number;
  duration?: number;
  padding?: MapViewportPadding;
}

/**
 * Ajuste et centre la vue sur une zone géographique (bounding box) sélectionnée.
 * Utilise une animation cinématique fluide et naturelle, avec calcul de padding
 * dynamique pour que l'intégralité de la zone sélectionnée soit parfaitement visible.
 */
export function flyToBounds(
  map: MapboxMap | null | undefined,
  bounds: [[number, number], [number, number]],
  options?: FlyToBoundsOptions,
): void {
  if (!map) return;
  const [[minLon, minLat], [maxLon, maxLat]] = bounds;
  if (
    !Number.isFinite(minLon) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat)
  ) {
    return;
  }

  try {
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const spanLon = Math.abs(maxLon - minLon);
    const spanLat = Math.abs(maxLat - minLat);

    // Si la zone est minuscule (< 25 mètres), centrer en tant que point individuel
    if (spanLon < 0.00025 && spanLat < 0.00025) {
      flyToLocation(
        map,
        { lon: centerLon, lat: centerLat },
        {
          zoom: options?.maxZoom ?? 16.2,
          pitch: options?.pitch,
          duration: options?.duration,
          padding: options?.padding,
        },
      );
      return;
    }

    const currentCenter = map.getCenter();
    const currentPitch = map.getPitch();
    const distKm = haversineDistanceKm(currentCenter.lat, currentCenter.lng, centerLat, centerLon);

    const duration = options?.duration ?? Math.max(950, computeAdaptiveFlightDuration(distKm));
    const padding = options?.padding ?? getMapViewportPadding(map);

    const is2D = currentPitch <= 8;
    const targetPitch = options?.pitch ?? (is2D ? 0 : Math.max(currentPitch, 48));

    map.fitBounds(bounds, {
      padding,
      maxZoom: options?.maxZoom ?? 16.2,
      linear: false,
      pitch: targetPitch,
      bearing: options?.bearing ?? map.getBearing(),
      duration,
      curve: 1.42,
      speed: 1.2,
      essential: true,
    });
  } catch {
    /* noop */
  }
}
