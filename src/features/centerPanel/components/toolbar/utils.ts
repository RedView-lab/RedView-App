export const DETAILED_POINTS_PER_KM = 60;
export const BALANCED_POINTS_PER_KM = 30;
export const LIGHT_POINTS_PER_KM = 15;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeDefaultPointsPerKm(currentPointsPerKm: number): number {
  if (currentPointsPerKm <= BALANCED_POINTS_PER_KM) {
    return Math.max(LIGHT_POINTS_PER_KM, Math.round(currentPointsPerKm));
  }
  if (currentPointsPerKm <= DETAILED_POINTS_PER_KM) {
    return BALANCED_POINTS_PER_KM;
  }
  return DETAILED_POINTS_PER_KM;
}

export function routePointsEqual(
  left: Array<{ lat: number; lon: number; distanceM?: number; elevationM?: number | null }>,
  right: Array<{ lat: number; lon: number; distanceM?: number; elevationM?: number | null }>,
): boolean {
  return (
    left.length === right.length &&
    left.every((point, index) => {
      const other = right[index];
      return (
        point.lat === other?.lat &&
        point.lon === other.lon &&
        point.distanceM === other.distanceM &&
        point.elevationM === other.elevationM
      );
    })
  );
}