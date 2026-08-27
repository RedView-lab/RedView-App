import { fromWgs84 } from '../../lib/coordConvert';
import type {
  LidarRouteMeshGeometry,
  LidarRouteOverlayItem,
  ViewerRouteRenderOptions,
  ViewerRouteSceneParams,
} from './types';

interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
  inTile: boolean;
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_RIBBON_WIDTH_M = 3.2;
const DEFAULT_ELEVATION_BIAS_M = 0.65;
const SUBDIVISION_STEP_M = 2.5;
const TILE_SAFETY_MARGIN_M = 150;

function parseHexColor(colorStr: string): RgbaColor {
  const normalized = colorStr.trim().replace(/^#/, '');

  if (normalized.length === 3) {
    return {
      r: parseInt(normalized[0] + normalized[0], 16),
      g: parseInt(normalized[1] + normalized[1], 16),
      b: parseInt(normalized[2] + normalized[2], 16),
      a: 255,
    };
  }

  if (normalized.length === 6) {
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
      a: 255,
    };
  }

  if (normalized.length === 8) {
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
      a: parseInt(normalized.slice(6, 8), 16),
    };
  }

  return { r: 229, g: 57, b: 53, a: 255 }; // Default Red
}

function sampleLocalElevation(
  x: number,
  y: number,
  params: ViewerRouteSceneParams,
  elevationBias: number,
  fallbackElevM: number | null,
): number {
  const { bounds, heightGrid, gridWidth, gridHeight, centerZ } = params;
  const fallbackLocalY = (fallbackElevM !== null ? fallbackElevM - centerZ : 0) + elevationBias;

  if (!heightGrid || !gridWidth || !gridHeight || gridWidth < 2 || gridHeight < 2) {
    return fallbackLocalY;
  }

  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;

  if (rangeX <= 0 || rangeY <= 0) return fallbackLocalY;

  const gx = ((x - bounds.minX) / rangeX) * (gridWidth - 1);
  const gy = ((y - bounds.minY) / rangeY) * (gridHeight - 1);

  if (gx < 0 || gx > gridWidth - 1 || gy < 0 || gy > gridHeight - 1) {
    return fallbackLocalY;
  }

  const x0 = Math.min(gridWidth - 2, Math.max(0, Math.floor(gx)));
  const y0 = Math.min(gridHeight - 2, Math.max(0, Math.floor(gy)));
  const fx = gx - x0;
  const fy = gy - y0;

  const z00 = heightGrid[y0 * gridWidth + x0];
  const z10 = heightGrid[y0 * gridWidth + (x0 + 1)];
  const z01 = heightGrid[(y0 + 1) * gridWidth + x0];
  const z11 = heightGrid[(y0 + 1) * gridWidth + (x0 + 1)];

  if (
    Number.isFinite(z00) &&
    Number.isFinite(z10) &&
    Number.isFinite(z01) &&
    Number.isFinite(z11)
  ) {
    let interpolated =
      (1 - fx) * (1 - fy) * z00! +
      fx * (1 - fy) * z10! +
      (1 - fx) * fy * z01! +
      fx * fy * z11!;

    // If heightGrid contains absolute altitudes (e.g. ~2000m near centerZ), convert to local camera Y (Z - cz)
    if (centerZ > 50 && Math.abs(interpolated - centerZ) < Math.abs(interpolated)) {
      interpolated -= centerZ;
    }

    return interpolated + elevationBias;
  }

  return fallbackLocalY;
}

function densifyAndProjectRoute(
  route: LidarRouteOverlayItem,
  params: ViewerRouteSceneParams,
  elevationBias: number,
): ProjectedPoint[][] {
  const { bounds, crs, centerX, centerY } = params;
  const minX = bounds.minX - TILE_SAFETY_MARGIN_M;
  const maxX = bounds.maxX + TILE_SAFETY_MARGIN_M;
  const minY = bounds.minY - TILE_SAFETY_MARGIN_M;
  const maxY = bounds.maxY + TILE_SAFETY_MARGIN_M;

  const rawProjected: Array<{ x: number; y: number; elevationM: number | null }> = [];

  for (const pt of route.points) {
    const [projX, projY] = fromWgs84(pt.lon, pt.lat, crs);
    rawProjected.push({
      x: projX,
      y: projY,
      elevationM: pt.elevationM ?? null,
    });
  }

  if (rawProjected.length < 2) return [];

  const chains: ProjectedPoint[][] = [];
  let currentChain: ProjectedPoint[] = [];

  const pushPoint = (x: number, y: number, fallbackElev: number | null) => {
    const inBounds = x >= minX && x <= maxX && y >= minY && y <= maxY;
    if (!inBounds) {
      if (currentChain.length > 1) {
        chains.push(currentChain);
      }
      currentChain = [];
      return;
    }

    const localY = sampleLocalElevation(x, y, params, elevationBias, fallbackElev);

    // Convert to viewer local coordinates
    // local X = x - cx
    // local Y = local elevation above center
    // local Z = -(y - cy)
    const localPt: ProjectedPoint = {
      x: x - centerX,
      y: localY,
      z: -(y - centerY),
      inTile: inBounds,
    };

    const last = currentChain[currentChain.length - 1];
    if (last && Math.hypot(last.x - localPt.x, last.z - localPt.z) < 0.2) {
      return; // Skip duplicate / ultra close vertices
    }

    currentChain.push(localPt);
  };

  for (let i = 0; i < rawProjected.length - 1; i++) {
    const p0 = rawProjected[i]!;
    const p1 = rawProjected[i + 1]!;
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);

    const steps = Math.max(1, Math.ceil(dist / SUBDIVISION_STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const curX = p0.x + (p1.x - p0.x) * t;
      const curY = p0.y + (p1.y - p0.y) * t;
      const curElev =
        p0.elevationM !== null && p1.elevationM !== null
          ? p0.elevationM + (p1.elevationM - p0.elevationM) * t
          : p0.elevationM ?? p1.elevationM;

      pushPoint(curX, curY, curElev);
    }
  }

  // Push final point
  const lastRaw = rawProjected[rawProjected.length - 1]!;
  pushPoint(lastRaw.x, lastRaw.y, lastRaw.elevationM);

  if (currentChain.length > 1) {
    chains.push(currentChain);
  }

  return chains;
}

export function buildLidarRouteMesh(
  routes: LidarRouteOverlayItem[],
  params: ViewerRouteSceneParams,
  options: ViewerRouteRenderOptions = {},
): LidarRouteMeshGeometry | null {
  if (!routes || routes.length === 0 || options.enabled === false) return null;

  const ribbonWidth = options.ribbonWidthM ?? DEFAULT_RIBBON_WIDTH_M;
  const halfWidth = ribbonWidth * 0.5;
  const elevationBias = options.elevationBiasM ?? DEFAULT_ELEVATION_BIAS_M;
  const globalOpacity = Math.max(0, Math.min(1, options.opacityScale ?? 1.0));

  const allVertices: number[] = [];
  const allColors: number[] = [];
  const allIndices: number[] = [];

  let vertexOffset = 0;

  for (const route of routes) {
    if (!route.visible) continue;
    if (!route.points || route.points.length < 2) continue;

    const baseColor = parseHexColor(route.color);
    const alpha = Math.max(0, Math.min(255, Math.round(baseColor.a * route.opacity * globalOpacity)));
    if (alpha <= 2) continue;

    const chains = densifyAndProjectRoute(route, params, elevationBias);

    for (const chain of chains) {
      if (chain.length < 2) continue;

      const chainVertexStart = vertexOffset;

      // Outer border color (darker for contrast)
      const borderR = Math.max(0, Math.round(baseColor.r * 0.25));
      const borderG = Math.max(0, Math.round(baseColor.g * 0.25));
      const borderB = Math.max(0, Math.round(baseColor.b * 0.25));
      const borderAlpha = Math.round(alpha * 0.85);

      for (let i = 0; i < chain.length; i++) {
        const cur = chain[i];

        // Determine tangent direction in XZ plane
        let tanX = 0;
        let tanZ = 0;

        if (i === 0) {
          tanX = chain[1].x - cur.x;
          tanZ = chain[1].z - cur.z;
        } else if (i === chain.length - 1) {
          tanX = cur.x - chain[i - 1].x;
          tanZ = cur.z - chain[i - 1].z;
        } else {
          tanX = chain[i + 1].x - chain[i - 1].x;
          tanZ = chain[i + 1].z - chain[i - 1].z;
        }

        const len = Math.hypot(tanX, tanZ) || 1;
        const normTanX = tanX / len;
        const normTanZ = tanZ / len;

        // Normal perpendicular in XZ plane: (-tanZ, 0, tanX)
        const perpX = -normTanZ;
        const perpZ = normTanX;

        // 4 vertices per slice: Left Outer, Left Inner, Right Inner, Right Outer
        // Outer width = halfWidth * 1.28
        // Inner width = halfWidth * 0.90
        const outW = halfWidth * 1.25;
        const inW = halfWidth * 0.85;

        // Left Outer
        allVertices.push(cur.x + perpX * outW, cur.y, cur.z + perpZ * outW);
        allColors.push(borderR, borderG, borderB, borderAlpha);

        // Left Inner
        allVertices.push(cur.x + perpX * inW, cur.y, cur.z + perpZ * inW);
        allColors.push(baseColor.r, baseColor.g, baseColor.b, alpha);

        // Right Inner
        allVertices.push(cur.x - perpX * inW, cur.y, cur.z - perpZ * inW);
        allColors.push(baseColor.r, baseColor.g, baseColor.b, alpha);

        // Right Outer
        allVertices.push(cur.x - perpX * outW, cur.y, cur.z - perpZ * outW);
        allColors.push(borderR, borderG, borderB, borderAlpha);

        vertexOffset += 4;
      }

      // Connect quad strips
      for (let i = 0; i < chain.length - 1; i++) {
        const row0 = chainVertexStart + i * 4;
        const row1 = chainVertexStart + (i + 1) * 4;

        // Quad 1: Left Border (Left Outer -> Left Inner)
        allIndices.push(row0 + 0, row0 + 1, row1 + 1);
        allIndices.push(row0 + 0, row1 + 1, row1 + 0);

        // Quad 2: Main Center Ribbon (Left Inner -> Right Inner)
        allIndices.push(row0 + 1, row0 + 2, row1 + 2);
        allIndices.push(row0 + 1, row1 + 2, row1 + 1);

        // Quad 3: Right Border (Right Inner -> Right Outer)
        allIndices.push(row0 + 2, row0 + 3, row1 + 3);
        allIndices.push(row0 + 2, row1 + 3, row1 + 2);
      }
    }
  }

  if (allVertices.length === 0 || allIndices.length === 0) {
    return null;
  }

  return {
    vertices: new Float32Array(allVertices),
    colors: new Uint8Array(allColors),
    indices: new Uint32Array(allIndices),
    vertexCount: allVertices.length / 3,
    indexCount: allIndices.length,
  };
}
