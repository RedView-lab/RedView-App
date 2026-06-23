export function buildAnalysisHoverGeoJson(
  point?: { lon: number; lat: number; color?: string } | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: point
      ? [
          {
            type: 'Feature',
            properties: { color: point.color ?? '#ffffff' },
            geometry: {
              type: 'Point',
              coordinates: [point.lon, point.lat],
            },
          },
        ]
      : [],
  };
}

export interface RouteHoverPreviewPoint {
  lon: number;
  lat: number;
  color?: string;
  /**
   * When true the marker renders dimmed, signalling that a click at this
   * position would be ignored (e.g. the cursor is too far from the trace in
   * split mode). False ⇒ full-strength "clickable" marker.
   */
  dimmed?: boolean;
}

export function buildRouteHoverPreviewGeoJson(
  point?: RouteHoverPreviewPoint | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: point
      ? [
          {
            type: 'Feature',
            properties: {
              color: point.color ?? '#ff4d4f',
              dimmed: Boolean(point.dimmed),
            },
            geometry: {
              type: 'Point',
              coordinates: [point.lon, point.lat],
            },
          },
        ]
      : [],
  };
}

export function buildAnalysisFlyoverProgressGeoJson(
  coordinates?: [number, number][] | null,
  color?: string,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      coordinates && coordinates.length >= 2
        ? [
            {
              type: 'Feature',
              properties: { color: color ?? '#ff4d4f' },
              geometry: {
                type: 'LineString',
                coordinates,
              },
            },
          ]
        : [],
  };
}

export function buildRouteAuditGeoJson(
  findings?: Array<{ id: string; coordinates: [number, number][]; title: string; detail: string }> | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      findings?.flatMap((finding) =>
        finding.coordinates.length >= 2
          ? [
              {
                type: 'Feature' as const,
                properties: {
                  id: finding.id,
                  color: '#ff3b30',
                  title: finding.title,
                  detail: finding.detail,
                },
                geometry: {
                  type: 'LineString' as const,
                  coordinates: finding.coordinates,
                },
              },
            ]
          : [],
      ) ?? [],
  };
}

function closePolygonRing(coordinates: [number, number][]): [number, number][] {
  if (coordinates.length === 0) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coordinates;
  return [...coordinates, first];
}

export function buildForbiddenZoneGeoJson(
  zones?: Array<{ id: string; points: Array<{ lon: number; lat: number }> }> | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      zones?.flatMap((zone) => {
        if (zone.points.length < 3) return [];
        return [
          {
            type: 'Feature' as const,
            properties: {
              id: zone.id,
              color: '#ff3b30',
              fillColor: '#ff3b30',
            },
            geometry: {
              type: 'Polygon' as const,
              coordinates: [closePolygonRing(zone.points.map((point) => [point.lon, point.lat]))],
            },
          },
        ];
      }) ?? [],
  };
}

export function buildForbiddenZoneDraftGeoJson(
  points?: Array<{ lon: number; lat: number }> | null,
): GeoJSON.FeatureCollection {
  if (!points || points.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }

  const features: GeoJSON.Feature[] = points.map((point, index) => ({
    type: 'Feature',
    properties: {
      role: 'vertex',
      index,
      color: '#ff3b30',
      fillColor: '#ffffff',
    },
    geometry: {
      type: 'Point',
      coordinates: [point.lon, point.lat],
    },
  }));

  if (points.length >= 2) {
    const edgeCount = points.length >= 3 ? points.length : points.length - 1;
    for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
      const start = points[edgeIndex];
      const end = points[(edgeIndex + 1) % points.length];
      if (!start || !end) continue;
      features.push({
        type: 'Feature',
        properties: { role: 'edge', edgeIndex },
        geometry: {
          type: 'LineString',
          coordinates: [
            [start.lon, start.lat],
            [end.lon, end.lat],
          ],
        },
      });
    }
  }

  if (points.length >= 3) {
    features.unshift({
      type: 'Feature',
      properties: {
        role: 'shape',
        color: '#ff3b30',
        fillColor: '#ff3b30',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [closePolygonRing(points.map((point) => [point.lon, point.lat]))],
      },
    });
  } else if (points.length >= 2) {
    features.unshift({
      type: 'Feature',
      properties: {
        role: 'shape',
        color: '#ff3b30',
        fillColor: '#ff3b30',
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map((point) => [point.lon, point.lat]),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}