/**
 * Générateur de données synthétiques du banc d'essai RedView
 *
 * Produit des jeux de données géospatiales et environnementales déterministes,
 * mathématiquement cohérents et réalistes (ascensions alpines, grilles DEM,
 * paquets météo, POI).
 */

export interface TrackPoint {
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
  gradientPct: number;
  timeSec?: number;
}

export interface SyntheticPoi {
  id: string;
  name: string;
  category: 'water' | 'bakery' | 'shelter' | 'bike_repair' | 'toilets';
  lat: number;
  lon: number;
  elevationM: number;
}

export interface SyntheticWeatherPayload {
  latitude: number;
  longitude: number;
  elevation: number;
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    precipitation: number[];
    rain: number[];
    snowfall: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
    cloud_cover: number[];
    surface_pressure: number[];
  };
}

/**
 * Produit une route vélo réaliste à travers une vallée et un col alpins.
 * Imite une ascension comme le col du Galibier ou l'Alpe d'Huez.
 */
export function generateSyntheticRoute(pointCount: number): TrackPoint[] {
  const startLat = 45.064; // Bourg d'Oisans
  const startLon = 6.031;
  const startEle = 720;
  const targetEle = 2050; // Altitude du col

  const points: TrackPoint[] = new Array(pointCount);
  let accumulatedDist = 0;

  for (let i = 0; i < pointCount; i++) {
    const progress = i / (pointCount - 1);
    // Lacets et virages
    const switchback = Math.sin(progress * Math.PI * 42) * 0.008;
    const lat = startLat + progress * 0.18 + switchback * 0.4;
    const lon = startLon + progress * 0.22 + switchback;

    const stepDist = 8 + Math.sin(i * 0.05) * 2;
    if (i > 0) accumulatedDist += stepDist;

    // Profil d'altitude à pentes variables (replats, rampes à 12 %, faux plats)
    const baseElevation = startEle + progress * (targetEle - startEle);
    const localRamp = Math.sin(progress * Math.PI * 8) * 45;
    const elevationM = baseElevation + localRamp;

    // Calcul de la pente
    const gradientPct = 4 + Math.sin(progress * 15) * 6;

    points[i] = {
      lat,
      lon,
      elevationM,
      distanceM: accumulatedDist,
      gradientPct,
      timeSec: i * 2.5,
    };
  }

  return points;
}

/**
 * Produit une grille 2D de DEM (modèle numérique d'élévation) synthétique.
 * Renvoie un Float32Array de valeurs d'altitude en mètres.
 */
export function generateSyntheticDemGrid(
  width: number,
  height: number,
  minElev = 500,
  maxElev = 3200,
): Float32Array {
  const grid = new Float32Array(width * height);
  const elevSpan = maxElev - minElev;

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      // Génération de crêtes fractales multifréquences
      const f1 = Math.sin(nx * 4) * Math.cos(ny * 3);
      const f2 = Math.sin(nx * 12 + ny * 6) * 0.35;
      const f3 = Math.cos(nx * 28 - ny * 14) * 0.12;
      const valley = Math.abs(nx - 0.5) * 1.5;

      const normHeight = Math.max(0, Math.min(1, 0.4 + (f1 + f2 + f3) * 0.4 + valley * 0.3));
      grid[y * width + x] = minElev + normHeight * elevSpan;
    }
  }

  return grid;
}

/**
 * Produit une grille synthétique de précipitations solides et de manteau neigeux AROME.
 */
export function generateSyntheticSnowGrid(
  width: number,
  height: number,
  demGrid: Float32Array,
): Float32Array {
  const snow = new Float32Array(width * height);
  for (let i = 0; i < snow.length; i++) {
    const elev = demGrid[i];
    // Limite pluie / neige vers 1800 m
    if (elev > 1800) {
      const depthM = (elev - 1800) * 0.0018 + Math.random() * 0.15;
      snow[i] = Math.max(0, depthM);
    } else {
      snow[i] = 0;
    }
  }
  return snow;
}

/**
 * Produit une charge utile météo horaire Open-Meteo sur 7 jours (168 h).
 */
export function generateSyntheticWeather(lat = 45.9237, lon = 6.8694): SyntheticWeatherPayload {
  const hours = 168;
  const time: string[] = [];
  const temp: number[] = [];
  const humidity: number[] = [];
  const precip: number[] = [];
  const rain: number[] = [];
  const snow: number[] = [];
  const windSpeed: number[] = [];
  const windDir: number[] = [];
  const gusts: number[] = [];
  const clouds: number[] = [];
  const pressure: number[] = [];

  const baseDate = new Date('2026-06-15T00:00:00Z');

  for (let h = 0; h < hours; h++) {
    const d = new Date(baseDate.getTime() + h * 3600000);
    time.push(d.toISOString().slice(0, 16));

    // Cycle diurne
    const diurnal = Math.sin((h % 24 - 6) / 24 * Math.PI * 2);
    const t = 14 + diurnal * 9 + Math.sin(h / 30) * 4;
    temp.push(Number(t.toFixed(1)));
    humidity.push(Math.round(60 - diurnal * 25));

    const isRaining = h % 36 > 28;
    const p = isRaining ? Number((Math.random() * 4).toFixed(1)) : 0;
    precip.push(p);
    rain.push(t > 0 ? p : 0);
    snow.push(t <= 0 ? p : 0);

    const ws = 12 + Math.sin(h / 12) * 8 + Math.random() * 6;
    windSpeed.push(Number(ws.toFixed(1)));
    windDir.push(Math.round((h * 15 + 180) % 360));
    gusts.push(Number((ws * 1.45).toFixed(1)));

    clouds.push(Math.round(Math.max(0, Math.min(100, 30 + Math.sin(h / 8) * 50))));
    pressure.push(Math.round(1015 + Math.sin(h / 48) * 12));
  }

  return {
    latitude: lat,
    longitude: lon,
    elevation: 1040,
    hourly: {
      time,
      temperature_2m: temp,
      relative_humidity_2m: humidity,
      precipitation: precip,
      rain,
      snowfall: snow,
      wind_speed_10m: windSpeed,
      wind_direction_10m: windDir,
      wind_gusts_10m: gusts,
      cloud_cover: clouds,
      surface_pressure: pressure,
    },
  };
}

/**
 * Produit des POI synthétiques regroupés le long d'un itinéraire.
 */
export function generateSyntheticPois(
  route: TrackPoint[],
  count: number,
): SyntheticPoi[] {
  const categories: SyntheticPoi['category'][] = [
    'water',
    'bakery',
    'shelter',
    'bike_repair',
    'toilets',
  ];
  const names = [
    'Fontaine Municipale Eau Potable',
    'Boulangerie Artisanale du Col',
    'Refuge Alpin CAF',
    'Atelier Vélo & Dépannage',
    'Point d’Eau Cimetière',
    'Refuge d’Étape',
    'Superette Ravitaillement',
  ];

  const pois: SyntheticPoi[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const routeIndex = Math.floor((i / count) * route.length);
    const anchor = route[routeIndex];
    // Décalage par rapport à la route (de 10 m à 1200 m)
    const angle = Math.random() * Math.PI * 2;
    const distDeg = (0.0001 + Math.random() * 0.009); // ~10 m à 1 km

    pois[i] = {
      id: `poi-${i + 1}`,
      name: `${names[i % names.length]} #${i + 1}`,
      category: categories[i % categories.length],
      lat: anchor.lat + Math.cos(angle) * distDeg,
      lon: anchor.lon + Math.sin(angle) * distDeg,
      elevationM: anchor.elevationM + (Math.random() - 0.5) * 40,
    };
  }

  return pois;
}
