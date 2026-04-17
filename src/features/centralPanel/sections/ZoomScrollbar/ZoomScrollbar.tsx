/**
 * Zoom scrollbar — Figma 1528:18653.
 *
 * Horizontal range slider that lets the user zoom the profile chart on a
 * sub-range of the route. Pure mouse-driven implementation: drag the
 * handle (move both edges), or drag either edge to resize.
 *
 * The component is fully controlled — it never owns the range, only emits
 * `onChangeRange([from, to])` (in km). Pass `range={null}` for "all".
 */
import { useCallback, useEffect, useRef } from 'react';

import { IconDots } from '../../components/icons';

interface ZoomScrollbarProps {
  totalKm: number;
  range: [number, number] | null;
  onChangeRange?: (next: [number, number] | null) => void;
}

const MIN_SPAN_RATIO = 0.05; // can't zoom below 5% of total

export function ZoomScrollbar({
  totalKm,
  range,
  onChangeRange,
}: ZoomScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    kind: 'move' | 'left' | 'right';
    startPx: number;
    startRange: [number, number];
  } | null>(null);

  const total = Math.max(1, totalKm);
  const [from, to] = range ?? [0, total];
  const fromPct = (from / total) * 100;
  const toPct = (to / total) * 100;

  const onMouseDown = useCallback(
    (kind: 'move' | 'left' | 'right') =>
      (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          kind,
          startPx: e.clientX,
          startRange: [from, to],
        };
      },
    [from, to],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || !track) return;
      const rect = track.getBoundingClientRect();
      const dxPx = e.clientX - drag.startPx;
      const dxKm = (dxPx / rect.width) * total;
      const minSpan = total * MIN_SPAN_RATIO;
      let [a, b] = drag.startRange;
      if (drag.kind === 'move') {
        const span = b - a;
        a = Math.max(0, Math.min(total - span, a + dxKm));
        b = a + span;
      } else if (drag.kind === 'left') {
        a = Math.max(0, Math.min(b - minSpan, a + dxKm));
      } else if (drag.kind === 'right') {
        b = Math.max(a + minSpan, Math.min(total, b + dxKm));
      }
      const isFull = a <= 0.0001 && b >= total - 0.0001;
      onChangeRange?.(isFull ? null : [a, b]);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onChangeRange, total]);

  return (
    <div className="rvc-zoom" role="group" aria-label="Zoom du graphique">
      <div ref={trackRef} className="rvc-zoom__track">
        <div
          className="rvc-zoom__handle"
          style={{
            left: `${fromPct}%`,
            width: `${Math.max(0, toPct - fromPct)}%`,
          }}
          onMouseDown={onMouseDown('move')}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalKm)}
          aria-valuenow={Math.round(from)}
        >
          <div
            className="rvc-zoom__edge rvc-zoom__edge--left"
            onMouseDown={onMouseDown('left')}
            aria-hidden
          />
          <div className="rvc-zoom__grip" aria-hidden>
            <IconDots size={14} />
          </div>
          <div
            className="rvc-zoom__edge rvc-zoom__edge--right"
            onMouseDown={onMouseDown('right')}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
