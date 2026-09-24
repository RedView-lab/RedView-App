import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface ChartZoomNavigatorProps {
  orientation: 'horizontal' | 'vertical';
  /** Fraction of full domain visible in window: [minFraction, 1.0] */
  visibleFraction: number;
  /** Normalized offset of visible window: [0.0, 1.0] */
  offset: number;
  onChange: (next: { visibleFraction: number; offset: number }) => void;
  className?: string;
  minFraction?: number;
  ariaLabel?: string;
}

type DragMode = 'body' | 'start' | 'end';

/**
 * Premiere Pro style zoom and pan navigator bar.
 * - Dragging the center body pans the visible window.
 * - Dragging the start/end handles zooms in/out.
 * - Clicking the track centers on that position.
 * - Double-clicking resets to 100% full view.
 */
export function ChartZoomNavigator({
  orientation,
  visibleFraction,
  offset,
  onChange,
  className = '',
  minFraction = 0.04,
  ariaLabel,
}: ChartZoomNavigatorProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeDrag, setActiveDrag] = useState<DragMode | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const dragSessionRef = useRef<{
    mode: DragMode;
    startCoord: number;
    initialStartRatio: number;
    initialEndRatio: number;
    trackPx: number;
  } | null>(null);

  const isH = orientation === 'horizontal';
  const clampedFraction = Math.max(minFraction, Math.min(1, visibleFraction));
  const clampedOffset = Math.max(0, Math.min(1, offset));

  // In normalized [0, 1] range:
  // For horizontal: start = 0 (left), end = 1 (right)
  // For vertical: value ratio 0 is bottom (min altitude), 1 is top (max altitude)
  const startRatio = clampedOffset * (1 - clampedFraction);
  const endRatio = startRatio + clampedFraction;

  const handlePointerDown = (mode: DragMode, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const trackPx = isH ? rect.width : rect.height;
    if (trackPx <= 0) return;

    setActiveDrag(mode);
    dragSessionRef.current = {
      mode,
      startCoord: isH ? e.clientX : e.clientY,
      initialStartRatio: startRatio,
      initialEndRatio: endRatio,
      trackPx,
    };
  };

  useEffect(() => {
    if (!activeDrag) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;
      e.preventDefault();

      const currentCoord = isH ? e.clientX : e.clientY;
      const deltaPx = currentCoord - session.startCoord;

      // For vertical: downward movement (deltaPx > 0) means decreasing altitude
      const deltaRatio = isH
        ? deltaPx / session.trackPx
        : -deltaPx / session.trackPx;

      const { mode, initialStartRatio, initialEndRatio } = session;
      const initialSpan = initialEndRatio - initialStartRatio;

      if (mode === 'body') {
        let nextStart = initialStartRatio + deltaRatio;
        nextStart = Math.max(0, Math.min(1 - initialSpan, nextStart));
        const nextOffset = initialSpan >= 0.999 ? 0 : nextStart / (1 - initialSpan);
        onChangeRef.current({ visibleFraction: initialSpan, offset: Math.max(0, Math.min(1, nextOffset)) });
      } else if (mode === 'start') {
        let nextStart = initialStartRatio + deltaRatio;
        nextStart = Math.max(0, Math.min(initialEndRatio - minFraction, nextStart));
        const nextSpan = initialEndRatio - nextStart;
        const nextOffset = nextSpan >= 0.999 ? 0 : nextStart / (1 - nextSpan);
        onChangeRef.current({
          visibleFraction: Math.max(minFraction, Math.min(1, nextSpan)),
          offset: Math.max(0, Math.min(1, nextOffset)),
        });
      } else if (mode === 'end') {
        let nextEnd = initialEndRatio + deltaRatio;
        nextEnd = Math.max(initialStartRatio + minFraction, Math.min(1, nextEnd));
        const nextSpan = nextEnd - initialStartRatio;
        const nextOffset = nextSpan >= 0.999 ? 0 : initialStartRatio / (1 - nextSpan);
        onChangeRef.current({
          visibleFraction: Math.max(minFraction, Math.min(1, nextSpan)),
          offset: Math.max(0, Math.min(1, nextOffset)),
        });
      }
    };

    const handleWindowPointerUp = () => {
      dragSessionRef.current = null;
      setActiveDrag(null);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, [activeDrag, isH, minFraction]);

  const handleTrackClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeDrag || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const trackPx = isH ? rect.width : rect.height;
    if (trackPx <= 0) return;

    const clickPx = isH ? e.clientX - rect.left : e.clientY - rect.top;
    const clickRatio = isH ? clickPx / trackPx : 1 - clickPx / trackPx;

    const halfSpan = clampedFraction / 2;
    const nextStart = Math.max(0, Math.min(1 - clampedFraction, clickRatio - halfSpan));
    const nextOffset = clampedFraction >= 0.999 ? 0 : nextStart / (1 - clampedFraction);

    onChange({ visibleFraction: clampedFraction, offset: Math.max(0, Math.min(1, nextOffset)) });
  };

  const handleDoubleClick = () => {
    // Reset to 100% full view
    onChange({ visibleFraction: 1, offset: 0 });
  };

  // Geometry calculations
  const thumbStyle: React.CSSProperties = isH
    ? {
        left: `${(startRatio * 100).toFixed(4)}%`,
        width: `${(clampedFraction * 100).toFixed(4)}%`,
      }
    : {
        // In screen Y: 0 is top, height is bottom
        // Top of thumb = 1 - endRatio
        top: `${((1 - endRatio) * 100).toFixed(4)}%`,
        height: `${(clampedFraction * 100).toFixed(4)}%`,
      };

  return (
    <div
      ref={trackRef}
      className={`rvc-zoom-bar rvc-zoom-bar--${orientation} ${className}${activeDrag ? ' is-dragging' : ''}`}
      onPointerDown={handleTrackClick}
      onDoubleClick={handleDoubleClick}
      role="scrollbar"
      aria-label={ariaLabel ?? (isH ? 'Zoom et défilement horizontal' : 'Zoom et défilement vertical')}
      aria-valuenow={Math.round(clampedOffset * 100)}
    >
      <div
        className={`rvc-zoom-bar__thumb${activeDrag ? ' is-active' : ''}`}
        style={thumbStyle}
        onPointerDown={(e) => handlePointerDown('body', e)}
      >
        {/* Start Handle (Left for H, Bottom for V) */}
        <div
          className={`rvc-zoom-bar__handle rvc-zoom-bar__handle--${isH ? 'left' : 'bottom'}`}
          onPointerDown={(e) => handlePointerDown('start', e)}
          title={isH ? 'Ajuster début' : 'Ajuster plancher'}
        />

        {/* Center Dots */}
        <div className="rvc-zoom-bar__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        {/* End Handle (Right for H, Top for V) */}
        <div
          className={`rvc-zoom-bar__handle rvc-zoom-bar__handle--${isH ? 'right' : 'top'}`}
          onPointerDown={(e) => handlePointerDown('end', e)}
          title={isH ? 'Ajuster fin' : 'Ajuster plafond'}
        />
      </div>
    </div>
  );
}
