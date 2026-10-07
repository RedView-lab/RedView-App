// Tri automatique des POI : pré-sélection de favoris d'après des règles
// horaires et géométriques (eau, ravitaillement, repas, hôtels, déserts).
// Module pur : l'appelant fournit le modèle horaire (voir AutoSortTimeModel).

import { buildCandidates, buildRouteIndex } from './enrich';
import { DEFAULT_AUTO_SORT_RULES } from './rules';
import { selectAutoSortPicks } from './select';
import type { AutoSortInput, AutoSortPick, AutoSortReason, AutoSortResult } from './types';

export * from './types';
export { DEFAULT_AUTO_SORT_RULES,  } from './rules';
;

const DEFAULT_MAX_LATERAL_M = 200;

export function autoSortPois(input: AutoSortInput): AutoSortResult {
  const rules = input.rules ?? DEFAULT_AUTO_SORT_RULES;
  const manualIds = input.manualFavoriteIds ?? new Set<string | number>();
  const route = buildRouteIndex(input.routePoints);
  const { candidates, descentsAvoided } = buildCandidates(
    input.features,
    route,
    rules,
    input.maxLateralMFor ?? (() => DEFAULT_MAX_LATERAL_M),
  );

  const { picks, warnings, hotelsPerNight } = selectAutoSortPicks(
    candidates,
    input.time,
    rules,
    manualIds,
    route.totalM,
  );

  const byReason: Record<AutoSortReason, number> = {
    water: 0,
    resupply: 0,
    bakery: 0,
    meal: 0,
    night: 0,
    hotel: 0,
    gap6h: 0,
  };
  for (const pick of picks) byReason[pick.reason]++;

  return {
    picks,
    warnings,
    stats: {
      candidates: candidates.length,
      manual: manualIds.size,
      byReason,
      maxWaterGapH: maxGapHours(picks.filter((p) => p.kind !== 'hotel' && (p.kind === 'water' || p.openStatus !== 'closed'))),
      maxResupplyGapH: maxGapHours(picks.filter((p) => p.kind === 'shop' || p.kind === 'meal' || p.kind === 'night')),
      descentsAvoided,
      hotelsPerNight,
    },
  };
}

function maxGapHours(picks: readonly AutoSortPick[]): number {
  let previous = 0;
  let max = 0;
  for (const pick of [...picks].sort((l, r) => l.scheduledSeconds - r.scheduledSeconds)) {
    max = Math.max(max, pick.scheduledSeconds - previous);
    previous = pick.scheduledSeconds;
  }
  return max / 3600;
}
