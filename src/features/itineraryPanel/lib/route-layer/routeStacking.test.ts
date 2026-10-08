import { describe, expect, it } from 'vitest';

import { planActiveRouteRestack } from './routeStacking';

/** Applique les déplacements comme `moveLayer(layerId, beforeId)` de Mapbox. */
function applyMoves(order: string[], moves: ReturnType<typeof planActiveRouteRestack>): string[] {
  const next = [...order];
  for (const { layerId, beforeId } of moves) {
    next.splice(next.indexOf(layerId), 1);
    next.splice(next.indexOf(beforeId), 0, layerId);
  }
  return next;
}

describe('planActiveRouteRestack', () => {
  const active = new Set(['a-outline', 'a-line']);
  const others = new Set(['b-outline', 'b-line', 'c-outline', 'c-line']);

  it('puts the selected route above the others, keeping their relative order and every other layer in place', () => {
    const order = ['terrain', 'a-outline', 'a-line', 'b-outline', 'b-line', 'labels', 'c-outline', 'c-line', 'poi'];

    const restacked = applyMoves(order, planActiveRouteRestack(order, active, others));

    expect(restacked).toEqual(['terrain', 'b-outline', 'b-line', 'c-outline', 'c-line', 'a-outline', 'a-line', 'labels', 'poi']);
  });

  it('moves nothing when the selected route is already on top', () => {
    const order = ['terrain', 'b-outline', 'b-line', 'a-outline', 'a-line', 'poi'];

    expect(planActiveRouteRestack(order, active, others)).toEqual([]);
  });

  it('moves nothing when the selected route is not mounted', () => {
    expect(planActiveRouteRestack(['b-outline', 'b-line'], active, others)).toEqual([]);
  });
});
