import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Minimal debug overlay: renders a red dot that follows the cursor
 * inside its parent. Drop it as a child of any `position: relative`
 * container to verify pointer tracking is alive.
 *
 * Usage:
 *   <div style={{ position: 'relative' }}>
 *     ...content...
 *     <HoverDebugDot />
 *   </div>
 */
export function HoverDebugDot() {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    const handleMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        setPos(null);
        return;
      }
      setPos({ x, y });
    };
    const handleLeave = () => setPos(null);

    parent.addEventListener('pointermove', handleMove);
    parent.addEventListener('pointerenter', handleMove);
    parent.addEventListener('pointerleave', handleLeave);
    parent.addEventListener('pointercancel', handleLeave);

    return () => {
      parent.removeEventListener('pointermove', handleMove);
      parent.removeEventListener('pointerenter', handleMove);
      parent.removeEventListener('pointerleave', handleLeave);
      parent.removeEventListener('pointercancel', handleLeave);
    };
  }, []);

  const surfaceStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 9999,
  };

  const dotStyle: CSSProperties | undefined = pos
    ? {
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: 16,
        height: 16,
        marginLeft: -8,
        marginTop: -8,
        borderRadius: '50%',
        background: 'red',
        boxShadow: '0 0 0 2px rgba(255,255,255,0.9)',
        pointerEvents: 'none',
      }
    : undefined;

  return (
    <div ref={surfaceRef} style={surfaceStyle} aria-hidden="true">
      {dotStyle ? <div style={dotStyle} /> : null}
    </div>
  );
}
