import type { JapanTileCoord } from './types';
import {
  japanCoordsToStandardSheet,
  getJapanTileBounds,
} from './coordConvert';

/**
 * Resolver for Japanese Point Cloud Open Data candidate URLs.
 * Direct public S3 buckets:
 * - virtual-shizuoka (Shizuoka Prefecture, Mount Fuji, Izu)
 * - japan-pointcloud (Tokyo, Yamanashi, Hyogo, Ishikawa, Saitama, Tochigi)
 */

export interface JapanS3Source {
  bucket: string;
  baseUrl: string;
  zone: number;
  years: number[];
  prefixBuilder: (year: number, zoneStr: string, letterPair: string, sheet5k: string, code: string) => string;
}

const SOURCES: JapanS3Source[] = [
  // Tokyo point clouds (Zone 09)
  {
    bucket: 'japan-pointcloud',
    baseUrl: 'https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com',
    zone: 9,
    years: [2024, 2023],
    prefixBuilder: (year, zoneStr, letterPair, sheet5k, code) =>
      `Tokyo/${year}/01/LP/Original/LAS/${zoneStr}/${letterPair}/${sheet5k}/${code}.zip`,
  },
  // Shizuoka point clouds (Zone 08 - Fuji, Izu, Shizuoka)
  {
    bucket: 'virtual-shizuoka',
    baseUrl: 'https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com',
    zone: 8,
    years: [2025, 2022, 2021, 2019],
    prefixBuilder: (year, zoneStr, letterPair, sheet5k, code) => {
      const type = (year === 2019 || year === 2022) ? 'Ground' : 'Original';
      return `${year}/LP/${type}/${zoneStr}/${letterPair}/${sheet5k}/${code}.zip`;
    },
  },
  // Yamanashi point clouds (Zone 08 - Mount Fuji North)
  {
    bucket: 'japan-pointcloud',
    baseUrl: 'https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com',
    zone: 8,
    years: [2024],
    prefixBuilder: (year, zoneStr, letterPair, sheet5k, code) =>
      `Yamanashi/${year}/01/LP/Original/LAS/${zoneStr}/${letterPair}/${sheet5k}/${code}.zip`,
  },
  // Ishikawa / Noto point clouds (Zone 07)
  {
    bucket: 'japan-pointcloud',
    baseUrl: 'https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com',
    zone: 7,
    years: [2024],
    prefixBuilder: (year, zoneStr, letterPair, sheet5k, code) =>
      `Ishikawa/${year}/01/LP/Original/LAS/${zoneStr}/${letterPair}/${sheet5k}/${code}.zip`,
  },
];

/**
 * Generate candidate download URLs for a given 1km² tile in Japan.
 */
export function buildJapanCandidateUrls(coord: JapanTileCoord): string[] {
  const { minE, minN, maxE, maxN } = getJapanTileBounds(coord);
  const midE = (minE + maxE) / 2;
  const midN = (minN + maxN) / 2;

  // Sample points across the 1km² footprint: center, corners and mid-points
  const samplePoints: [number, number][] = [
    [midE, midN],
    [minE + 100, minN + 100],
    [maxE - 100, minN + 100],
    [minE + 100, maxN - 100],
    [maxE - 100, maxN - 100],
    [minE + 100, midN],
    [maxE - 100, midN],
    [midE, minN + 100],
    [midE, maxN - 100],
  ];

  const sheets = samplePoints.map(([e, n]) => japanCoordsToStandardSheet(e, n, coord.zone));

  const candidateUrls: string[] = [];

  for (const sheet of sheets) {
    const letterPair = `${sheet.rowLetter}${sheet.colLetter}`;
    const matchingSources = SOURCES.filter((s) => s.zone === coord.zone);

    for (const src of matchingSources) {
      for (const yr of src.years) {
        const path = src.prefixBuilder(yr, sheet.zoneStr, letterPair, sheet.sheet5k, sheet.sheetCode);
        const url = `${src.baseUrl}/${path}`;
        candidateUrls.push(url);
      }
    }
  }

  // Deduplicate preserving order
  return Array.from(new Set(candidateUrls));
}
