import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Diagnostic overlay. Always visible so you can confirm it mounted.
 * - Yellow badge top-right shows mount + last pointer position.
 * - Red dot follows the cursor inside the parent container.
 */
export function HoverDebugDot() {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [events, setEvents] = useState(0);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const parent = el.parentElement;
    // eslint-disable-next-line no-console
    console.log('[HoverDebugDot] mounted, parent =', parent);
    if (!parent) return;

    const handleMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setEvents((n) => n + 1);
      setPos({ x, y });
    };
    const handleLeave = () => setPos(null);

    parent.addEventListener('pointermove', handleMove);
    parent.addEventListener('pointerleave', handleLeave);

    return () => {
      parent.removeEventListener('pointermove', handleMove);
      parent.removeEventListener('pointerleave', handleLeave);
    };
  }, []);

  const surfaceStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 99999,
  };

  const badgeStyle: CSSProperties = {
    position: 'absolute',
    top: 4,
    right: 4,
    padding: '4px 8px',
    background: 'yellow',
    color: 'black',
    font: '12px monospace',
    borderRadius: 4,
    pointerEvents: 'none',
    zIndex: 99999,
  };

  const dotStyle: CSSProperties | undefined = pos
    ? {
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: 20,
        height: 20,
        marginLeft: -10,
        marginTop: -10,
        borderRadius: '50%',
        background: 'red',
        boxShadow: '0 0 0 3px white',
        pointerEvents: 'none',
      }
    : undefined;

  return (
    <div ref={surfaceRef} style={surfaceStyle} aria-hidden="true">
      <div style={badgeStyle}>
        DBG mounted | events={events} | pos=
        {pos ? `${Math.round(pos.x)},${Math.round(pos.y)}` : 'null'}
      </div>
      {dotStyle ? <div style={dotStyle} /> : null}
    </div>
  );
}
