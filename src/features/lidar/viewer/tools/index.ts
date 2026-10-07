// ============================================
// LiDAR viewer tools — public API
// ============================================
//
// Right-click menu, measurements (distance, height/angle, area, profile) and
// mountain terrain analyses (fall line, avalanche exposure, viewshed) of the
// WebGPU viewer. See controller.ts for the input model.

import { computePointFilterBitmasks, type ViewerPointFilterState } from '../pointFilter';

export { ViewerToolsController,  } from './controller';

/** Class visibility predicate matching the renderer's point filter. */
export function pointFilterClassPredicate(state: ViewerPointFilterState): (classification: number) => boolean {
  if (!state.enabled) return () => true;
  const masks = computePointFilterBitmasks(state.enabled, state.categories);
  return (classification) => classification >= 128 || ((masks[classification >> 5]! >>> (classification & 31)) & 1) === 1;
}
