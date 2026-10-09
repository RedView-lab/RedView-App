import type { AppTranslationPair } from '../types';

/** Réglages → Sources des données (projectBrowser/settings/lib/dataSources.ts). */
export const creditsTranslationPairs: ReadonlyArray<AppTranslationPair> = [
  { fr: 'Sources des données', en: 'Data sources' },
  { fr: 'RedView s’appuie sur des données ouvertes et des services tiers. Merci à celles et ceux qui les produisent.', en: 'RedView relies on open data and third-party services. Thanks to the people who produce them.' },
  // ── Groupes ────────────────────────────────────────────────────────────────
  { fr: 'Carte, relief et imagerie', en: 'Map, terrain and imagery' },
  { fr: 'Nuages de points LiDAR', en: 'LiDAR point clouds' },
  { fr: 'Météo et neige', en: 'Weather and snow' },
  { fr: 'Points d’intérêt et itinéraires', en: 'Points of interest and routes' },
  // ── Usages ─────────────────────────────────────────────────────────────────
  { fr: 'Fond de carte, imagerie satellite, relief 3D et recherche de lieux', en: 'Basemap, satellite imagery, 3D terrain and place search' },
  { fr: 'Fond de carte, points d’intérêt, calcul d’itinéraires et lieux emblématiques', en: 'Basemap, points of interest, routing and landmark search' },
  { fr: 'Orthophotographies, altitudes et LiDAR HD en France', en: 'Orthophotos, elevation and LiDAR HD in France' },
  { fr: 'Relief mondial hors des pays couverts par un institut national', en: 'Worldwide terrain outside countries covered by a national institute' },
  { fr: 'Relief et LiDAR en Suisse', en: 'Terrain and LiDAR in Switzerland' },
  { fr: 'Relief en Norvège', en: 'Terrain in Norway' },
  { fr: 'Relief en Espagne', en: 'Terrain in Spain' },
  { fr: 'LiDAR aux Pays-Bas (via PDOK et GeoTiles)', en: 'LiDAR in the Netherlands (via PDOK and GeoTiles)' },
  { fr: 'LiDAR en Flandre (DHMV II)', en: 'LiDAR in Flanders (DHMV II)' },
  { fr: 'LiDAR en Nouvelle-Zélande (via OpenTopography)', en: 'LiDAR in New Zealand (via OpenTopography)' },
  { fr: 'Couleurs des nuages de points en Nouvelle-Zélande', en: 'Point cloud colours in New Zealand' },
  { fr: 'LiDAR et orthophotographies au Japon', en: 'LiDAR and orthophotos in Japan' },
  { fr: 'Prévisions AROME et ARPEGE, hauteurs de neige et bulletins d’avalanche', en: 'AROME and ARPEGE forecasts, snow depths and avalanche bulletins' },
  { fr: 'Moteur de prévisions, hébergé par RedView', en: 'Forecast engine, hosted by RedView' },
  { fr: 'Vent et météo à l’échelle mondiale', en: 'Worldwide wind and weather' },
  { fr: 'Radar de précipitations', en: 'Precipitation radar' },
  { fr: 'Hauteurs de neige des stations IMIS en Suisse', en: 'Snow depths from IMIS stations in Switzerland' },
  { fr: 'Points d’intérêt', en: 'Points of interest' },
  { fr: 'Points d’intérêt des enseignes', en: 'Chain store points of interest' },
  { fr: 'Établissements en France', en: 'Businesses in France' },
  // ── Licences ───────────────────────────────────────────────────────────────
  { fr: '© les contributeurs OpenStreetMap, ODbL 1.0', en: '© OpenStreetMap contributors, ODbL 1.0' },
  { fr: 'Licence Ouverte 2.0 (Etalab)', en: 'Open Licence 2.0 (Etalab)' },
  { fr: 'Sources et licences multiples', en: 'Multiple sources and licences' },
  { fr: '© swisstopo, données en libre accès', en: '© swisstopo, open government data' },
  { fr: '© Digitaal Vlaanderen, licence de réutilisation gratuite', en: '© Digitaal Vlaanderen, free reuse licence' },
  { fr: 'CC BY 4.0 et conditions du GSI', en: 'CC BY 4.0 and GSI terms of use' },
  { fr: 'AGPL-3.0, données CC BY 4.0', en: 'AGPL-3.0, data CC BY 4.0' },
  { fr: 'Domaine public', en: 'Public domain' },
  { fr: 'Licences des bibliothèques logicielles incluses dans RedView', en: 'Licences of the software libraries included in RedView' },
  // ── Réglages : mesure d'audience ──────────────────────────────────────────
  { fr: 'Mesure d’audience', en: 'Audience measurement' },
  { fr: 'Statistiques de visite anonymes, sans cookie, hébergées par RedView. Désactivées, plus rien n’est mesuré sur cet appareil.', en: 'Anonymous visit statistics, cookie-free, hosted by RedView. When turned off, nothing is measured on this device any more.' },
  // Licences et mentions identiques dans les deux langues.
  { fr: '© Kartverket, CC BY 4.0', en: '© Kartverket, CC BY 4.0' },
  { fr: '© Instituto Geográfico Nacional, CC BY 4.0', en: '© Instituto Geográfico Nacional, CC BY 4.0' },
  { fr: 'Sourced from LINZ. CC BY 4.0 · imagerie satellite © Maxar Technologies et données Copernicus Sentinel modifiées, sous licence Sinergise Ltd.', en: 'Sourced from LINZ. CC BY 4.0 · satellite imagery © Maxar Technologies and modified Copernicus Sentinel data, licensed by Sinergise Ltd.' },
  { fr: '© RainViewer', en: '© RainViewer' },
  { fr: 'CC BY 4.0', en: 'CC BY 4.0' },
  { fr: 'CC0 1.0', en: 'CC0 1.0' },
  { fr: 'MIT', en: 'MIT' },
];
