/**
 * RedView Test-Bench : LiDAR IGN & Nuages de Points 3D (avec Simulation Solaire)
 * 
 * Benchmarks :
 * 1. Reprojection géodésique haute fréquence Lambert-93 / Swiss LV95 vers WGS84 (toWgs84)
 * 2. Empaquetage de tampons GPU WebGL Float32Array (100 000 points 3D)
 * 3. Simulation Soleil dans le LiDAR :
 *    - Calcul de l'éphéméride solaire (vecteur d'éclairage L)
 *    - Éclairage direct Lambertien (N · L) sur les normales du nuage de points
 *    - Lancer de rayons d'ombres portées et exposition solaire (100k points)
 * 4. Filtrage spatial par corridor d'itinéraire (Bounding Box & R-Tree)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticRoute } from './core/synthetic-data.ts';
import { toWgs84, wgs84ToTile } from '../src/features/lidar/lib/coordConvert.ts';

export async function runLidarBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('LiDAR IGN & Nuages de Points 3D (avec Soleil & Ombres)');
  const iterations = options.quick ? 3 : 10;

  // 100 000 points LiDAR bruts synthétiques (Lambert-93 / Massif du Mont-Blanc)
  const numPoints = 100_000;
  const rawLidarX = new Float64Array(numPoints);
  const rawLidarY = new Float64Array(numPoints);
  const rawLidarZ = new Float32Array(numPoints);
  const rawIntensity = new Uint16Array(numPoints);
  const rawClass = new Uint8Array(numPoints);

  const baseLambX = 990_000;
  const baseLambY = 6_540_000;
  for (let i = 0; i < numPoints; i++) {
    rawLidarX[i] = baseLambX + (i % 316) * 3.16 + (Math.random() - 0.5) * 1.5;
    rawLidarY[i] = baseLambY + Math.floor(i / 316) * 3.16 + (Math.random() - 0.5) * 1.5;
    rawLidarZ[i] = 1200 + Math.sin(i * 0.01) * 350 + Math.cos(i * 0.003) * 120;
    rawIntensity[i] = Math.round(Math.random() * 65535);
    rawClass[i] = (i % 10 === 0) ? 6 : (i % 4 === 0 ? 5 : 2); // Bâtiment (6), Végétation (5), Sol (2)
  }

  // --- BENCHMARK 1 : Reprojection Géodésique Lambert-93 vers WGS84 (10k points) ---
  suite.measureSync(
    {
      name: 'Reprojection Géodésique Lambert-93 → WGS84 (10k pts)',
      category: 'lidar-proj4',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      const reprojected = new Float64Array(10_000 * 2);
      for (let i = 0; i < 10_000; i++) {
        const [lon, lat] = toWgs84(rawLidarX[i], rawLidarY[i], 'LAMB93');
        reprojected[i * 2] = lon;
        reprojected[i * 2 + 1] = lat;
      }
      return reprojected;
    },
  );

  // --- BENCHMARK 2 : Empaquetage Tampon WebGL (100k points entrelacés) ---
  suite.measureSync(
    {
      name: 'Empaquetage Tampon WebGL (100k pts x,y,z,rgba,norm)',
      category: 'lidar-packing',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 5.0,
      itemsProcessedPerOp: 100_000,
    },
    () => packLidarBufferForGpu(rawLidarX, rawLidarY, rawLidarZ, rawIntensity, rawClass, numPoints),
  );

  // --- BENCHMARK 3 : Simulation Soleil dans le LiDAR (Éphéméride & Éclairage N · L) ---
  suite.measureSync(
    {
      name: 'Simulation Soleil : Éclairage Lambertien (100k pts)',
      category: 'lidar-sunlight-shading',
      iterations,
      regressionThresholdP95Ms: 8.0,
      itemsProcessedPerOp: 100_000,
    },
    () => {
      // Calcul du vecteur soleil pour 15h00 en juin dans les Alpes (Azimut 225°, Élévation 52°)
      const sunAzimuthDeg = 225;
      const sunAltitudeDeg = 52;
      const sunDir = computeSunVector(sunAzimuthDeg, sunAltitudeDeg);

      return computeLidarSolarIllumination(rawLidarZ, numPoints, sunDir);
    },
  );

  // --- BENCHMARK 4 : Simulation Ombres Portées du Relief sur Nuage de Points (Ray-Casting) ---
  suite.measureSync(
    {
      name: 'Simulation Soleil : Ombres Portées Ray-Casting (100k pts)',
      category: 'lidar-sunlight-shadows',
      iterations: Math.max(2, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 30.0,
      itemsProcessedPerOp: 100_000,
    },
    () => {
      const sunDir = computeSunVector(225, 30); // Soleil plus bas (30°) projetant de longues ombres
      return computeLidarSelfShadows(rawLidarZ, 316, 316, 3.16, sunDir);
    },
  );

  // --- BENCHMARK 5 : Découpage tuiles Web-Mercator (wgs84ToTile) ---
  suite.measureSync(
    {
      name: 'Mapping Tuiles Web-Mercator Zoom 16 (10k pts)',
      category: 'lidar-tiling',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 2.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let sumTiles = 0;
      for (let i = 0; i < 10_000; i++) {
        const { tx, ty } = wgs84ToTile(6.86 + (i % 100) * 0.001, 45.92 + Math.floor(i / 100) * 0.001, 16);
        sumTiles += tx + ty;
      }
      return sumTiles;
    },
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Reprojection proj4.forward sur le Main Thread : proj4 est en JavaScript pur non-vectorisé (~1.2 µs/point, soit 1.2s pour 1M de points).',
  );
  suite.addRegressionRisk(
    'Lancer de rayons d’ombres solaires sur nuage de points non-indexé : complexité O(N × steps) provoquant des drops de framerate.',
  );
  suite.addRecommendation(
    'Déporter impérativement la reprojection géodésique proj4 dans un Web Worker ou utiliser une approximation polynomiale rapide (polynômes de Tchebychev sur la grille locale).',
  );
  suite.addRecommendation(
    'Calculer l’ombrage solaire (N · L et shadow map) directement dans le Vertex/Fragment Shader WebGL via une texture de profondeur (Shadow Mapping GPU).',
  );

  return suite;
}

function packLidarBufferForGpu(
  x: Float64Array,
  y: Float64Array,
  z: Float32Array,
  intensity: Uint16Array,
  cls: Uint8Array,
  count: number,
): Float32Array {
  // Structure interleaved : [x_rel, y_rel, z, intensity_norm, class_id, r, g, b] (8 floats par point = 32 octets)
  const buffer = new Float32Array(count * 8);
  const originX = x[0];
  const originY = y[0];

  for (let i = 0; i < count; i++) {
    const off = i * 8;
    buffer[off] = x[i] - originX;
    buffer[off + 1] = y[i] - originY;
    buffer[off + 2] = z[i];
    buffer[off + 3] = intensity[i] / 65535;
    buffer[off + 4] = cls[i];
    // Coloration par classification
    if (cls[i] === 2) { // Sol
      buffer[off + 5] = 0.6; buffer[off + 6] = 0.5; buffer[off + 7] = 0.4;
    } else if (cls[i] === 5) { // Végétation
      buffer[off + 5] = 0.1; buffer[off + 6] = 0.7; buffer[off + 7] = 0.2;
    } else { // Autre / Bâtiment
      buffer[off + 5] = 0.8; buffer[off + 6] = 0.2; buffer[off + 7] = 0.2;
    }
  }
  return buffer;
}

function computeSunVector(azimuthDeg: number, altitudeDeg: number): [number, number, number] {
  const azRad = (azimuthDeg * Math.PI) / 180;
  const altRad = (altitudeDeg * Math.PI) / 180;
  return [
    Math.sin(azRad) * Math.cos(altRad),
    Math.cos(azRad) * Math.cos(altRad),
    Math.sin(altRad),
  ];
}

function computeLidarSolarIllumination(
  z: Float32Array,
  count: number,
  sunDir: [number, number, number],
): Float32Array {
  const illumination = new Float32Array(count);
  const [sx, sy, sz] = sunDir;
  const sxy = -0.3 * (sx + sy);

  for (let i = 1; i < count - 1; i++) {
    // Estimation du gradient local de normale
    const dz = (z[i + 1] - z[i - 1]) * 0.5;
    const nxy = -dz * 0.3;
    const len = Math.sqrt(2 * (nxy * nxy) + 1.0);

    // Produit scalaire N · L
    const dot = (dz * sxy + sz) / len;
    illumination[i] = dot > 0.1 ? dot : 0.1; // 0.1 lumière ambiante minimale
  }
  return illumination;
}

function computeLidarSelfShadows(
  z: Float32Array,
  width: number,
  height: number,
  cellSize: number,
  sunDir: [number, number, number],
): Uint8Array {
  const total = width * height;
  const inShadow = new Uint8Array(total);
  const [sx, sy, sz] = sunDir;
  const tanSun = sz / Math.hypot(sx, sy);
  const stepX = Math.round(sx / Math.hypot(sx, sy));
  const stepY = Math.round(sy / Math.hypot(sx, sy));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const currentZ = z[idx];
      let shadowed = 0;

      // Marche de rayon vers le soleil (10 pas)
      for (let step = 1; step <= 10; step++) {
        const nx = x + stepX * step;
        const ny = y + stepY * step;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;

        const rayZ = currentZ + step * cellSize * tanSun;
        const terrainZ = z[ny * width + nx];
        if (terrainZ > rayZ) {
          shadowed = 1;
          break;
        }
      }
      inShadow[idx] = shadowed;
    }
  }
  return inShadow;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-lidar.ts')) {
  const quick = process.argv.includes('--quick');
  runLidarBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
