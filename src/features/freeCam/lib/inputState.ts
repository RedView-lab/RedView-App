import type { FreeCamAction, FreeCamAxes, FreeCamLookDelta } from '../types';

/** État d'input mutable partagé entre les listeners et la boucle rAF. */
export interface FreeCamInputState {
  pressed: Set<FreeCamAction>;
  lookDx: number;
  lookDy: number;
}

export function createInputState(): FreeCamInputState {
  return { pressed: new Set(), lookDx: 0, lookDy: 0 };
}

export function resetInputState(state: FreeCamInputState): void {
  state.pressed.clear();
  state.lookDx = 0;
  state.lookDy = 0;
}

export function readAxes(state: FreeCamInputState): FreeCamAxes {
  const has = (action: FreeCamAction) => (state.pressed.has(action) ? 1 : 0);
  return {
    forward: has('forward') - has('backward'),
    strafe: has('right') - has('left'),
    vertical: has('ascend') - has('descend'),
  };
}

/** Vide le delta souris accumulé et le renvoie. */
export function consumeLookDelta(state: FreeCamInputState): FreeCamLookDelta {
  const delta = { dx: state.lookDx, dy: state.lookDy };
  state.lookDx = 0;
  state.lookDy = 0;
  return delta;
}
