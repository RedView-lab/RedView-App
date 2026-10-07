import { useState } from 'react';

/**
 * True on the render where `value` differs (`Object.is`) from the previous
 * render's, false on the first render and while it stays the same.
 *
 * For « adjusting state when a prop changes » during render, as React
 * recommends, instead of an effect that sets state after the commit (an extra
 * render with the stale state on screen, react-hooks/set-state-in-effect):
 *
 *   const canEditChanged = useHasChanged(canEdit);
 *   if (canEditChanged && !canEdit) setArmed(false);
 *
 * The previous value is state: on a change React restarts the render at once,
 * before the children, and the next render sees no change.
 */
export function useHasChanged<T>(value: T): boolean {
  const [previous, setPrevious] = useState(value);
  if (Object.is(previous, value)) return false;
  setPrevious(value);
  return true;
}
