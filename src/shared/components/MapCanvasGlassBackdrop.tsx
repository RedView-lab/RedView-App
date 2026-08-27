import type { CSSProperties, ReactNode } from 'react';

export interface MapCanvasGlassBackdropProps {
  blur?: number;
  saturate?: number;
  tint?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * Composant de fond en verre dépoli (Glassmorphism) accéléré matériellement par le GPU.
 * Utilise `backdrop-filter` natif plutôt qu'une capture canvas périodique,
 * éliminant 100% des stalls GPU WebGL, des lectures synchrone et des copies DDR5.
 */
export function MapCanvasGlassBackdrop({
  blur = 20,
  saturate = 1.3,
  tint = 'rgba(15, 15, 18, 0.65)',
  className,
  style,
  children,
}: MapCanvasGlassBackdropProps) {
  return (
    <div
      aria-hidden={!children}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: children ? 'auto' : 'none',
        background: tint,
        backdropFilter: `blur(${blur}px) saturate(${saturate})`,
        WebkitBackdropFilter: `blur(${blur}px) saturate(${saturate})`,
        borderRadius: 'inherit',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}