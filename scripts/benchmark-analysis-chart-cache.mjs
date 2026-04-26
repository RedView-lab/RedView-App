import { buildSeriesFromPrediction } from '../src/features/centerPanel/components/chart/series.ts';

function createRoutePoints(pointCount) {
  return Array.from({ length: pointCount }, (_, index) => {
    const distanceM = index * 12;
    const wave = Math.sin(index / 90) * 35 + Math.sin(index / 17) * 4;
    return {
      lat: 47 + index * 0.00008,
      lon: 2 + index * 0.00011,
      distanceM,
      elevationM: 180 + wave + index * 0.015,
      gradientPct: Math.cos(index / 40) * 8,
    };
  });
}

function createPrediction(routePoints) {
  const points = routePoints.map((point, index) => ({
    distance_m: point.distanceM,
    elevation_m: point.elevationM,
    gradient_pct: point.gradientPct,
    predicted_speed_kmh: 22 + Math.sin(index / 120) * 6,
    predicted_power_w: 210 + Math.cos(index / 75) * 55,
    elapsed_time_s: index * 2.2,
    segment_time_s: 2.2,
  }));

  return {
    total_time_s: points[points.length - 1]?.elapsed_time_s ?? 0,
    riding_time_s: points[points.length - 1]?.elapsed_time_s ?? 0,
    stop_time_s: 0,
    total_distance_m: routePoints[routePoints.length - 1]?.distanceM ?? 0,
    avg_speed_kmh: 23,
    elevation_gain_m: 1400,
    elevation_loss_m: 1380,
    segments: [],
    points,
    rider_profile: {
      ftp_w: 260,
      mass_kg: 78,
      rider_weight_kg: 70,
      bike_weight_kg: 8,
      wkg: 3.3,
      cda: 0.32,
      crr: 0.005,
      has_power: true,
    },
  };
}

function measure(label, fn) {
  const start = performance.now();
  const value = fn();
  const elapsedMs = performance.now() - start;
  const pointSuffix = Array.isArray(value) ? ` (${value.length} pts)` : '';
  console.log(`${label}: ${elapsedMs.toFixed(2)} ms${pointSuffix}`);
  return value;
}

const routePoints = createRoutePoints(24_000);
const prediction = createPrediction(routePoints);

measure('cold altitude heure', () =>
  buildSeriesFromPrediction(prediction, 'Altitude', 'heure', routePoints, 'gpx', '08:00'),
);
measure('warm altitude heure x200', () => {
  let latest = null;
  for (let index = 0; index < 200; index += 1) {
    latest = buildSeriesFromPrediction(prediction, 'Altitude', 'heure', routePoints, 'gpx', '08:00');
  }
  return latest;
});

measure('cold slope temps', () =>
  buildSeriesFromPrediction(prediction, 'Inclinaison (%)', 'temps', routePoints, 'gpx', '08:00'),
);
measure('warm slope temps x200', () => {
  let latest = null;
  for (let index = 0; index < 200; index += 1) {
    latest = buildSeriesFromPrediction(prediction, 'Inclinaison (%)', 'temps', routePoints, 'gpx', '08:00');
  }
  return latest;
});

measure('cold speed avg temps', () =>
  buildSeriesFromPrediction(prediction, 'Vitesse moyenne', 'temps', routePoints, 'gpx', '08:00'),
);
measure('warm speed avg temps x200', () => {
  let latest = null;
  for (let index = 0; index < 200; index += 1) {
    latest = buildSeriesFromPrediction(prediction, 'Vitesse moyenne', 'temps', routePoints, 'gpx', '08:00');
  }
  return latest;
});