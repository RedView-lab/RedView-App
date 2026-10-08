/**
 * RedView Test-Bench : Pente (Slope Engine & Horn 3x3)
 *
 * Mesure le VRAI code de l'overlay pente :
 * 1. Pipeline du Service Worker (public/sw-dem/workers/slope-math.js, chargé
 *    comme le SW et son pool de workers) : Horn 3×3 sur la tuile + bordures
 *    voisines, Catmull-Rom 2× (256 → 512), PNG gris, tuile complète, tuile de
 *    zone d'analyse (gris + alpha).
 * 2. PNG gris 512 : encodeur actuel (zlibDeflateRle) vs l'ancien
 *    (CompressionStream, zlib niveau 6), même scanlines Paeth.
 * 3. Route de secours serveur /slope-tiles (server/lib/terrain-tiles.mjs) À FROID :
 *    une tuile différente par itération, Terrarium simulé (sans réseau). Ces
 *    tuiles sont en cache LRU : remesurer la même tuile ne mesurait que le
 *    cache (0,002 ms dans les rapports jusqu'au 2026-10-01).
 * 4. Compilation des expressions Mapbox raster-color (buildSlopeColorExpression).
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { generateSyntheticDemGrid } from '../core/synthetic-data.ts';
import { loadSwModules } from '../core/sw-context.ts';
import { encodeTerrariumPng, withTerrariumFetch } from '../core/terrarium-mock.ts';
import { buildSlopeColorExpression } from '../../src/features/slope/lib/slope-config.ts';
import { generateSlopeTile } from '../../server/lib/terrain-tiles.mjs';
import type { SlopeCategory } from '../../src/features/slope/types.ts';

type Neighbours = { north?: Float32Array; east?: Float32Array; south?: Float32Array; west?: Float32Array };
type SlopeSw = {
  buildPaddedElevationsFromArrays: (own: Float32Array, nb: Neighbours) => { pad: Float32Array };
  computeSlopeField: (pad: Float32Array, z: number, y: number) => Float32Array;
  upsampleSlopeField2x: (field: Float32Array) => Uint8Array;
  buildGrayPng: (w: number, h: number, gray: Uint8Array) => Promise<Blob>;
  buildPngFromScanlines: (w: number, h: number, raw: Uint8Array, colorType: number) => Promise<Blob>;
  buildSlopePngFromElevations: (
    own: Float32Array, nb: Neighbours, z: number, x: number, y: number,
    options: { outputScale?: number; zoneRing?: number[][] },
  ) => Promise<{ blob: Blob }>;
};

const TILE = 256;
// Tuile z13 du massif du Mont-Blanc, voisines comprises.
const Z = 13;
const X = 4252;
const Y = 2917;

/**
 * Relief 256² continu d'une tuile à l'autre (grille synthétique 3×3 découpée),
 * avec une micro-rugosité déterministe de ±1,5 m : sans elle le champ de pente
 * est plus lisse que tout MNT réel et se compresse 2-3× plus vite et mieux
 * qu'une vraie tuile (Terrarium Mont-Blanc z13 : 69 Ko, 20-33 ms en niveau 6).
 */
function neighbourhood(): { own: Float32Array; nb: Neighbours } {
  const big = generateSyntheticDemGrid(TILE * 3, TILE * 3, 900, 4200);
  let seed = 42;
  for (let i = 0; i < big.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    big[i] += 3 * (seed / 0x7fffffff - 0.5);
  }
  const cut = (tx: number, ty: number) => {
    const out = new Float32Array(TILE * TILE);
    for (let r = 0; r < TILE; r++) {
      out.set(big.subarray((ty * TILE + r) * TILE * 3 + tx * TILE, (ty * TILE + r) * TILE * 3 + tx * TILE + TILE), r * TILE);
    }
    return out;
  };
  return { own: cut(1, 1), nb: { north: cut(1, 0), south: cut(1, 2), west: cut(0, 1), east: cut(2, 1) } };
}

/** Scanlines Paeth de `gray`, comme buildGrayPng (référence de l'ancien encodeur). */
function paethScanlines(gray: Uint8Array, width: number): Uint8Array {
  const raw = new Uint8Array(width * (width + 1));
  for (let y = 0; y < width; y++) {
    raw[y * (width + 1)] = 4;
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? gray[y * width + x - 1] : 0;
      const b = y > 0 ? gray[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? gray[(y - 1) * width + x - 1] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      raw[y * (width + 1) + 1 + x] = (gray[y * width + x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  return raw;
}

export async function runSlopeBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Pente (Slope & Horn 3x3)');
  const iterations = options.quick ? 5 : 20;
  const sw = loadSwModules([
    'core/config.js',
    'core/geo.js',
    'core/terrain-rgb.js',
    'workers/slope-math.js',
  ]) as unknown as SlopeSw;

  const { own, nb } = neighbourhood();
  const pad = sw.buildPaddedElevationsFromArrays(own, nb).pad;
  const field = sw.computeSlopeField(pad, Z, Y);
  const gray512 = sw.upsampleSlopeField2x(field);

  const sampleCategories: SlopeCategory[] = [
    { id: 'flat', label: '0% - 5%', displayRange: '0 – 5 %', minDeg: 0, maxDeg: 2.86, color: '#2DBF8C' },
    { id: 'gentle', label: '5% - 8%', displayRange: '5 – 8 %', minDeg: 2.86, maxDeg: 4.57, color: '#7CD95F' },
    { id: 'moderate', label: '8% - 12%', displayRange: '8 – 12 %', minDeg: 4.57, maxDeg: 6.84, color: '#FFD800' },
    { id: 'steep', label: '12% - 16%', displayRange: '12 – 16 %', minDeg: 6.84, maxDeg: 9.09, color: '#FF7200' },
    { id: 'wall', label: '> 16%', displayRange: '> 16 %', minDeg: 9.09, maxDeg: 45, color: '#FF0000' },
  ];

  // ── Pipeline SW ─────────────────────────────────────────────────────
  suite.measureSync(
    {
      name: 'SW : Horn 3x3 tuile 256 + marges (computeSlopeField)',
      category: 'slope-horn-sw',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 4.0,
      itemsProcessedPerOp: TILE * TILE,
    },
    () => sw.computeSlopeField(sw.buildPaddedElevationsFromArrays(own, nb).pad, Z, Y),
  );
  suite.measureSync(
    {
      name: 'SW : Catmull-Rom 2x 256 → 512',
      category: 'slope-upsample-sw',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 4.0,
      itemsProcessedPerOp: 512 * 512,
    },
    () => sw.upsampleSlopeField2x(field),
  );
  const pngNew = await suite.measureAsync(
    {
      name: 'SW : PNG gris 512 (Paeth + zlibDeflateRle)',
      category: 'slope-png-sw',
      iterations,
      regressionThresholdP95Ms: 12.0,
    },
    () => sw.buildGrayPng(512, 512, gray512),
  );
  const pngOld = await suite.measureAsync(
    {
      name: 'SW : PNG gris 512 — ancien (CompressionStream niv. 6)',
      category: 'slope-png-sw-legacy',
      iterations: Math.max(3, iterations >> 1),
    },
    () => sw.buildPngFromScanlines(512, 512, paethScanlines(gray512, 512), 0),
  );
  const newSize = (await sw.buildGrayPng(512, 512, gray512)).size;
  const oldSize = (await sw.buildPngFromScanlines(512, 512, paethScanlines(gray512, 512), 0)).size;
  // Sur de vraies tuiles (Terrarium Mont-Blanc, Lyon, Paris, suréchantillonnées
  // ×2-×4) le RLE est à ±5 % du niveau 6 ; ce champ synthétique, plus lisse que
  // tout relief réel, lui laisse +15-20 %. Le seuil attrape un encodeur cassé
  // (un bloc non compressé ferait ×9), pas cet écart.
  if (newSize > oldSize * 1.25) {
    throw new Error(`[bench-pente] PNG pente ${newSize} o > 1,25 × l'ancien encodeur (${oldSize} o)`);
  }
  console.log(`[bench-pente] PNG gris 512 : ${(newSize / 1024).toFixed(1)} Ko (ancien ${(oldSize / 1024).toFixed(1)} Ko), `
    + `p50 ${pngNew.p50Ms.toFixed(2)} ms (ancien ${pngOld.p50Ms.toFixed(2)} ms)`);

  await suite.measureAsync(
    {
      name: 'SW : tuile pente complète 512 (4 voisines)',
      category: 'slope-tile-sw',
      iterations,
      regressionThresholdP95Ms: 25.0,
    },
    () => sw.buildSlopePngFromElevations(own, nb, Z, X, Y, { outputScale: 2 }),
  );
  const zoneRing = [[6.86, 45.88], [6.9, 45.88], [6.9, 45.91], [6.86, 45.91]];
  await suite.measureAsync(
    {
      name: 'SW : tuile pente zone 256 (gris + alpha)',
      category: 'slope-tile-sw-zone',
      iterations,
      regressionThresholdP95Ms: 20.0,
    },
    () => sw.buildSlopePngFromElevations(own, nb, Z, X, Y, { outputScale: 1, zoneRing }),
  );

  // ── Expressions Mapbox ──────────────────────────────────────────────
  suite.measureSync(
    {
      name: 'Compilation Mapbox Expression (Gradient)',
      category: 'slope-expression',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 0.5,
    },
    () => buildSlopeColorExpression(sampleCategories, 'gradient'),
  );
  suite.measureSync(
    {
      name: 'Compilation Mapbox Expression (Step + Masque)',
      category: 'slope-expression',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 0.5,
    },
    () => buildSlopeColorExpression(sampleCategories, 'step', ['moderate']),
  );

  // ── Route de secours serveur, à froid ──────────────────────────────
  const terrarium = encodeTerrariumPng(own);
  let column = 0;
  await withTerrariumFetch(terrarium, async () => {
    const cold = async (z: number, x: number, y: number) => {
      const png = await generateSlopeTile(z, x, y);
      if (!png) throw new Error(`[bench-pente] /slope-tiles ${z}/${x}/${y} a rendu null`);
      return png;
    };
    await suite.measureAsync(
      {
        name: 'Serveur /slope-tiles à froid (z12)',
        category: 'slope-tile-server',
        iterations: options.quick ? 4 : 12,
        regressionThresholdP95Ms: 40.0,
      },
      () => cold(12, 1000 + column++, 1445),
    );
    await suite.measureAsync(
      {
        name: 'Serveur /slope-tiles à froid suréchantillonnée (z16)',
        category: 'slope-tile-server-z16',
        iterations: options.quick ? 4 : 12,
        regressionThresholdP95Ms: 40.0,
      },
      // Un ancêtre z14 différent à chaque itération (sinon son décodage est en cache).
      () => cold(16, (2000 + column++) * 4, 23120),
    );
  });

  suite.addRegressionRisk(
    'Encodage PNG : 90 % du temps d\'une tuile pente 512 avec CompressionStream (niveau 6 imposé) — garder zlibDeflateRle pour la tuile grise.',
  );
  suite.addRegressionRisk(
    'Le pool de workers pente et le chemin SW doivent rester octet pour octet identiques (même slope-math.js / terrain-rgb.js).',
  );
  suite.addRecommendation(
    'Les tuiles gris + alpha (zone, NoData) restent en niveau 6 : le RLE y est 12-18 % plus gros (alpha entrelacé).',
  );

  return suite;
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/pente.ts')) {
  const quick = process.argv.includes('--quick');
  runSlopeBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
