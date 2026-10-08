import type { FootDiscipline, SportDiscipline } from '@/shared/lib/discipline';
import type { RoadPreference } from '../../types';
import type { ActivityType, SurfaceType } from '../../lib/project/syncTracageParams';
import { isActivityPresetId, isFootActivity } from '../../lib/project/profilePresets';
import type { SavedCustomProfile } from '../../lib/project/customProfiles';

/** Options et libellés de la section Traçage, et résolution de l'activité active. */

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  road: 'Cyclisme sur route',
  'gravel-default': 'Gravel',
  mtb: 'VTT',
  running: 'Running',
  trail: 'Trail',
};

export const BIKE_ACTIVITIES: ActivityType[] = ['road', 'gravel-default', 'mtb'];
export const FOOT_ACTIVITIES: FootDiscipline[] = ['running', 'trail'];

/** Préréglage intégré derrière le profil actif (un profil enregistré garde son préréglage de base). */
export function resolveActivityKey(
  baseId: string,
  saved: SavedCustomProfile | undefined,
  footDiscipline: FootDiscipline | null,
): ActivityType {
  if (isActivityPresetId(baseId)) return baseId;
  if (isActivityPresetId(saved?.basePresetId)) return saved.basePresetId;
  return footDiscipline ?? 'road';
}

export function disciplineForActivity(activity: ActivityType): SportDiscipline {
  return isFootActivity(activity) ? activity : 'bike';
}

export const ROAD_PREF_OPTIONS: { value: RoadPreference; label: string }[] = [
  { value: 'prefer', label: 'Privilégier' },
  { value: 'tolerate', label: 'Tolérer' },
  { value: 'avoid', label: 'Éviter' },
  { value: 'forbid', label: 'Interdire' },
];

export const TOLERANCE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];

export const SLOPE_OPTIONS = [8, 10, 12, 15, 20, 25];
/** On foot, mountain paths routinely exceed 25 %. */
export const FOOT_SLOPE_OPTIONS = [...SLOPE_OPTIONS, 30, 40, 50];

export const SURFACES: { id: SurfaceType; label: string; pct: number }[] = [
  { id: 'tarmac', label: 'Tarmac', pct: 0 },
  { id: 'paved', label: 'Paved', pct: 33.333 },
  { id: 'gravel', label: 'Gravel', pct: 66.667 },
  { id: 'other', label: 'Other', pct: 100 },
];
