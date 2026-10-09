/**
 * Sources des données et services tiers affichés dans « Réglages → Sources
 * des données ». Plusieurs licences imposent une attribution visible (ODbL
 * d'OpenStreetMap, Licence Ouverte d'Etalab, CC BY 4.0 d'Open-Meteo, de
 * Kartverket, de l'IGN espagnol, du SLF…) : la carte Mapbox n'affiche que
 * celles de ses propres sources. Toute nouvelle source de données que l'app
 * affiche ou dont elle tire un résultat s'ajoute ici.
 *
 * `name` est un nom propre (jamais traduit) ; `description` et `licenseLabel`
 * sont traduits à l'affichage (paires dans translations/credits.ts).
 */

interface DataSource {
  name: string;
  description: string;
  licenseLabel: string;
  href: string;
}

export interface DataSourceGroup {
  title: string;
  sources: readonly DataSource[];
}

export const DATA_SOURCE_GROUPS: readonly DataSourceGroup[] = [
  {
    title: 'Carte, relief et imagerie',
    sources: [
      {
        name: 'Mapbox',
        description: 'Fond de carte, imagerie satellite, relief 3D et recherche de lieux',
        licenseLabel: '© Mapbox',
        href: 'https://www.mapbox.com/about/maps',
      },
      {
        name: 'OpenStreetMap',
        description: 'Fond de carte, points d’intérêt, calcul d’itinéraires et lieux emblématiques',
        licenseLabel: '© les contributeurs OpenStreetMap, ODbL 1.0',
        href: 'https://www.openstreetmap.org/copyright',
      },
      {
        name: 'IGN – Géoplateforme',
        description: 'Orthophotographies, altitudes et LiDAR HD en France',
        licenseLabel: 'Licence Ouverte 2.0 (Etalab)',
        href: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
      },
      {
        name: 'Terrain Tiles (Mapzen, AWS Open Data)',
        description: 'Relief mondial hors des pays couverts par un institut national',
        licenseLabel: 'Sources et licences multiples',
        href: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
      },
      {
        name: 'swisstopo',
        description: 'Relief et LiDAR en Suisse',
        licenseLabel: '© swisstopo, données en libre accès',
        href: 'https://www.swisstopo.admin.ch',
      },
      {
        name: 'Kartverket',
        description: 'Relief en Norvège',
        licenseLabel: '© Kartverket, CC BY 4.0',
        href: 'https://www.kartverket.no',
      },
      {
        name: 'Instituto Geográfico Nacional',
        description: 'Relief en Espagne',
        licenseLabel: '© Instituto Geográfico Nacional, CC BY 4.0',
        href: 'https://www.ign.es',
      },
    ],
  },
  {
    title: 'Nuages de points LiDAR',
    sources: [
      {
        name: 'AHN',
        description: 'LiDAR aux Pays-Bas (via PDOK et GeoTiles)',
        licenseLabel: 'CC0 1.0',
        href: 'https://www.ahn.nl',
      },
      {
        name: 'Digitaal Vlaanderen',
        description: 'LiDAR en Flandre (DHMV II)',
        licenseLabel: '© Digitaal Vlaanderen, licence de réutilisation gratuite',
        href: 'https://www.vlaanderen.be/digitaal-vlaanderen',
      },
      {
        name: 'Toitū Te Whenua LINZ',
        description: 'LiDAR en Nouvelle-Zélande (via OpenTopography)',
        licenseLabel: 'CC BY 4.0',
        href: 'https://www.linz.govt.nz',
      },
      {
        name: 'LINZ Basemaps',
        description: 'Couleurs des nuages de points en Nouvelle-Zélande',
        // Texte imposé par LINZ pour l'imagerie aérienne (attributing-linz-basemaps-data).
        licenseLabel: 'Sourced from LINZ. CC BY 4.0 · imagerie satellite © Maxar Technologies et données Copernicus Sentinel modifiées, sous licence Sinergise Ltd.',
        href: 'https://www.linz.govt.nz/copyright',
      },
      {
        name: 'GSI, AIST 3DDB, préfectures de Shizuoka et Kanagawa',
        description: 'LiDAR et orthophotographies au Japon',
        licenseLabel: 'CC BY 4.0 et conditions du GSI',
        href: 'https://www.gsi.go.jp',
      },
    ],
  },
  {
    title: 'Météo et neige',
    sources: [
      {
        name: 'Météo-France',
        description: 'Prévisions AROME et ARPEGE, hauteurs de neige et bulletins d’avalanche',
        licenseLabel: 'Licence Ouverte 2.0 (Etalab)',
        href: 'https://meteo.data.gouv.fr',
      },
      {
        name: 'Open-Meteo',
        description: 'Moteur de prévisions, hébergé par RedView',
        licenseLabel: 'AGPL-3.0, données CC BY 4.0',
        href: 'https://open-meteo.com',
      },
      {
        name: 'NOAA GFS',
        description: 'Vent et météo à l’échelle mondiale',
        licenseLabel: 'Domaine public',
        href: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast',
      },
      {
        name: 'RainViewer',
        description: 'Radar de précipitations',
        licenseLabel: '© RainViewer',
        href: 'https://www.rainviewer.com',
      },
      {
        name: 'SLF (WSL)',
        description: 'Hauteurs de neige des stations IMIS en Suisse',
        licenseLabel: 'CC BY 4.0',
        href: 'https://www.slf.ch',
      },
    ],
  },
  {
    title: 'Points d’intérêt et itinéraires',
    sources: [
      {
        name: 'Overture Maps Foundation',
        description: 'Points d’intérêt',
        licenseLabel: 'CDLA-Permissive-2.0',
        href: 'https://overturemaps.org',
      },
      {
        name: 'All the Places',
        description: 'Points d’intérêt des enseignes',
        licenseLabel: 'CC0 1.0',
        href: 'https://www.alltheplaces.xyz',
      },
      {
        name: 'INSEE – Sirene',
        description: 'Établissements en France',
        licenseLabel: 'Licence Ouverte 2.0 (Etalab)',
        href: 'https://www.sirene.fr',
      },
      {
        name: 'BRouter',
        description: 'Moteur de routage',
        licenseLabel: 'MIT',
        href: 'https://brouter.de',
      },
    ],
  },
];
