import {
  cleanAndInterpolateElevations,
  hasCorruptedElevations,
  isValidElevation,
  sanitizeRawElevation,
  MIN_VALID_TERRESTRIAL_ELEVATION_M,
  MAX_VALID_TERRESTRIAL_ELEVATION_M,
} from '../src/features/itineraryPanel/lib/route-metrics/elevationSanitizer.ts';
import { parseGpxText } from '../src/features/poi/lib/gpx-parse.ts';
import { buildImportedRouteMetrics } from '../src/features/itineraryPanel/lib/routes/imported-route.ts';
import { normalizeItineraryProject } from '../src/features/itineraryPanel/lib/project/defaultState.ts';
import { normalizeMetricDomain, computeCumulativeElevationAtX } from '../src/features/centerPanel/components/chart/AnalysisChart/math.ts';
import { computeDomain } from '../src/features/centerPanel/components/chart/series/builders.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('\n--- 1. Tests de validation des altitudes unitaires ---');
assert(!isValidElevation(-13000), 'isValidElevation(-13000) doit être faux');
assert(!isValidElevation(-9522), 'isValidElevation(-9522) doit être faux');
assert(!isValidElevation(-32768), 'isValidElevation(-32768) (code sentinelle) doit être faux');
assert(!isValidElevation(-9999), 'isValidElevation(-9999) (code sentinelle) doit être faux');
assert(!isValidElevation(15000), 'isValidElevation(15000) (hors limites) doit être faux');
assert(!isValidElevation(null), 'isValidElevation(null) doit être faux');
assert(!isValidElevation(NaN), 'isValidElevation(NaN) doit être faux');
assert(isValidElevation(0), 'isValidElevation(0) doit être vrai (niveau de la mer)');
assert(isValidElevation(1500), 'isValidElevation(1500) doit être vrai');
assert(isValidElevation(-200), 'isValidElevation(-200) doit être vrai (mer Morte / vallée)');
assert(isValidElevation(4810), 'isValidElevation(4810) (Mont-Blanc) doit être vrai');

console.log('\n--- 2. Tests de détection de corruption sur un parcours ---');
const cleanPoints = [
  { distanceM: 0, elevationM: 100 },
  { distanceM: 1000, elevationM: 150 },
  { distanceM: 2000, elevationM: 200 },
];
assert(!hasCorruptedElevations(cleanPoints), 'hasCorruptedElevations(cleanPoints) doit être faux');

const buggyPoints = [
  { distanceM: 0, elevationM: 500 },
  { distanceM: 96400, elevationM: -9522 }, // Bug exact utilisateur !
  { distanceM: 100000, elevationM: 520 },
];
assert(hasCorruptedElevations(buggyPoints), 'hasCorruptedElevations(buggyPoints) doit détecter -9522m');

console.log('\n--- 3. Tests de nettoyage et interpolation d\'un pic négatif isolé (-9522m à 96.4km) ---');
const simulatedRoute = [
  { lat: 45.0, lon: 5.0, distanceM: 0, elevationM: 500 },
  { lat: 45.1, lon: 5.1, distanceM: 50000, elevationM: 600 },
  { lat: 45.2, lon: 5.2, distanceM: 96000, elevationM: 650 },
  { lat: 45.21, lon: 5.21, distanceM: 96400, elevationM: -9522 }, // Pic erroné !
  { lat: 45.22, lon: 5.22, distanceM: 96800, elevationM: 670 },
  { lat: 45.3, lon: 5.3, distanceM: 150000, elevationM: 800 },
];

const cleaned = cleanAndInterpolateElevations(simulatedRoute);
assert(cleaned.length === simulatedRoute.length, 'Nombre de points conservé');
const fixedPoint = cleaned[3];
assert(fixedPoint.elevationM !== -9522, 'Le point à 96.4km ne doit plus être -9522m');
assert(
  fixedPoint.elevationM != null && fixedPoint.elevationM >= 650 && fixedPoint.elevationM <= 670,
  `Le point à 96.4km doit être interpolé entre 650m et 670m (valeur: ${fixedPoint.elevationM}m)`
);

console.log('\n--- 4. Tests sur le calcul des métriques (D+ / D-) sans explosion ---');
const metricsBefore = buildImportedRouteMetrics(simulatedRoute);
assert(
  metricsBefore.descentM != null && metricsBefore.descentM < 500,
  `D- calculé doit rester normal (< 500m), valeur obtenue: ${metricsBefore.descentM}m (au lieu de >10000m)`
);

console.log('\n--- 5. Tests du parsing GPX XML avec élévation aberrante ---');
const rawGpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk>
    <name>Buggy Route</name>
    <trkseg>
      <trkpt lat="45.0" lon="5.0"><ele>500.0</ele></trkpt>
      <trkpt lat="45.1" lon="5.1"><ele>550.0</ele></trkpt>
      <trkpt lat="45.2" lon="5.2"><ele>-13000.0</ele></trkpt>
      <trkpt lat="45.3" lon="5.3"><ele>600.0</ele></trkpt>
      <trkpt lat="45.4" lon="5.4"><ele>650.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const parsedGpx = parseGpxText(rawGpxXml);
assert(parsedGpx.points.length === 5, '5 points extraits du GPX');
const corruptedPtInGpx = parsedGpx.points[2];
assert(corruptedPtInGpx.elevationM !== -13000, 'Point -13000m doit être éliminé');
assert(
  corruptedPtInGpx.elevationM != null && corruptedPtInGpx.elevationM >= 550 && corruptedPtInGpx.elevationM <= 600,
  `Point intermédiaire interpolé correctement (valeur: ${corruptedPtInGpx.elevationM}m)`
);

console.log('\n--- 6. Tests des échelles du panneau central (normalizeMetricDomain & computeDomain) ---');
const domainResult = normalizeMetricDomain('Altitude', { min: -13000, max: 1500 });
assert(domainResult.min >= -500, `Min borné physiquement à >= -500m (obtenu: ${domainResult.min}m)`);
assert(domainResult.max <= 9000, `Max borné physiquement à <= 9000m (obtenu: ${domainResult.max}m)`);

const nearSeaDomain = normalizeMetricDomain('Altitude', { min: -5, max: 800 });
assert(nearSeaDomain.min === 0, `Base alignée à 0m pour un départ côtier (obtenu: ${nearSeaDomain.min}m)`);

const flatDomain = normalizeMetricDomain('Altitude', { min: 200, max: 205 });
assert(flatDomain.max - flatDomain.min >= 60, 'Échelle minimale garantie de 60m sur parcours plat');

const filteredDomain = computeDomain([[
  { x: 0, y: 500 },
  { x: 50, y: 800 },
  { x: 96.4, y: -9522 }, // Doit être ignoré par computeDomain
  { x: 100, y: 600 },
]]);
assert(filteredDomain !== null, 'Domain non nul');
assert(filteredDomain!.min >= 0, `computeDomain ignore l'anomalie -9522m, min calculé: ${filteredDomain!.min}m`);

console.log('\n--- 7. Tests de computeCumulativeElevationAtX (tooltip hover) ---');
const tooltipElevations = [
  { x: 0, y: 500 },
  { x: 50, y: 600 },
  { x: 96.4, y: -9522 },
  { x: 100, y: 650 },
];
const hoverMetrics = computeCumulativeElevationAtX(tooltipElevations, 100);
assert(
  hoverMetrics.lossM < 1000,
  `Le D- au survol reste physiquement plausible (< 1000m), valeur obtenue: -${hoverMetrics.lossM}m (au lieu de -11029m)`
);

console.log('\n--- 8. Tests d\'auto-guérison d\'un projet existant (normalizeItineraryProject) ---');
const dummyProject: any = {
  id: 'test-proj',
  name: 'Projet Test',
  itineraries: [
    {
      id: 'it-1',
      name: 'Itinéraire avec pic',
      gpxRoute: {
        points: simulatedRoute,
      },
      metrics: {
        distanceKm: 150,
        ascentM: 300,
        descentM: 11029, // Ancienne valeur erronée stockée
      },
      rhythm: {},
    },
  ],
};

const healedProject = normalizeItineraryProject(dummyProject);
const healedRoute = healedProject.itineraries[0].gpxRoute!;
const healedMetrics = healedProject.itineraries[0].metrics!;
assert(
  healedRoute.points[3].elevationM !== -9522,
  'Point corrompu guéri dans le projet existant'
);
assert(
  healedMetrics.descentM != null && healedMetrics.descentM < 500,
  `D- auto-guéri à ${healedMetrics.descentM}m (corrigé depuis 11029m)`
);

console.log('\n🎉 TOUS LES TESTS SONT PASSÉS AVEC SUCCÈS !');
