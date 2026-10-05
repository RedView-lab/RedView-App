import { describe, expect, it } from 'vitest';

import {
  beginTracePointPress,
  draggedAnchorPoint,
  passesDragThreshold,
  TRACE_POINT_DRAG_THRESHOLD_PX,
} from './tracePointGesture';

describe('trace point gesture', () => {
  it('stays a click under the drag threshold', () => {
    const press = beginTracePointPress({ x: 100, y: 100 }, { x: 40, y: 40 }, { x: 40, y: 40 });

    expect(passesDragThreshold(press, { x: 102, y: 102 })).toBe(false);
    expect(passesDragThreshold(press, { x: 100 + TRACE_POINT_DRAG_THRESHOLD_PX, y: 100 })).toBe(true);
  });

  it('drops the marker anchor, not the pointer: a flag grabbed by its top lands under its tip', () => {
    // Pin anchored at its bottom (tip at y = 230), grabbed 28 px higher.
    const press = beginTracePointPress({ x: 500, y: 400 }, { x: 200, y: 202 }, { x: 200, y: 230 });

    expect(draggedAnchorPoint(press, { x: 260, y: 302 })).toEqual({ x: 260, y: 330 });
  });

  it('drops under the pointer when the marker anchor is unknown', () => {
    const press = beginTracePointPress({ x: 0, y: 0 }, { x: 10, y: 10 }, null);

    expect(draggedAnchorPoint(press, { x: 50, y: 60 })).toEqual({ x: 50, y: 60 });
  });
});
