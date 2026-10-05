import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface MapCursorLoaderProps {
  /** Indique si un calcul de tracé ou d'itinéraire est en cours */
  loading?: boolean;
}

const SPINNER_STYLES = `
@keyframes rv-cursor-loader-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes rv-cursor-loader-in {
  0% { opacity: 0; transform: scale(0.6); }
  100% { opacity: 1; transform: scale(1); }
}
`;

const LOADER_SIZE = 22;

const pillStyle: CSSProperties = {
  width: LOADER_SIZE,
  height: LOADER_SIZE,
  borderRadius: '50%',
  background: 'light-dark(rgba(255, 255, 255, 0.96), rgba(15, 17, 23, 0.94))',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1.5px solid light-dark(rgba(17, 17, 20, 0.12), rgba(255, 255, 255, 0.32))',
  boxShadow: '0 3px 10px light-dark(rgba(16, 18, 24, 0.2), rgba(0, 0, 0, 0.55)), 0 0 0 1px light-dark(rgba(16, 18, 24, 0.06), rgba(0, 0, 0, 0.4))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'rv-cursor-loader-in 0.12s cubic-bezier(0.16, 1, 0.3, 1) forwards',
};

const spinnerStyle: CSSProperties = {
  width: 13,
  height: 13,
  borderRadius: '50%',
  border: '2px solid rgb(var(--rv-ink) / 0.16)',
  borderTopColor: '#3b82f6',
  borderRightColor: '#60a5fa',
  animation: 'rv-cursor-loader-spin 0.6s linear infinite',
  boxSizing: 'border-box',
};

/**
 * Micro-loader minimaliste qui colle au curseur de la souris pendant les calculs d'itinéraire BRouter.
 * Rendu directement dans document.body (createPortal) pour éviter toute distorsion causée
 * par `transform: scale(...)` du layout, et mis à jour immédiatement en phase de capture (0ms lag).
 */
export function MapCursorLoader({ loading = false }: MapCursorLoaderProps) {
  const [eventLoading, setEventLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  const isVisibleRef = useRef(false);

  // Écoute de l'événement global de calcul d'itinéraire
  useEffect(() => {
    const handleRouteLoading = (e: Event) => {
      const custom = e as CustomEvent<{ loading: boolean }>;
      if (typeof custom.detail?.loading === 'boolean') {
        setEventLoading(custom.detail.loading);
      }
    };
    window.addEventListener('rv-route-loading', handleRouteLoading);
    return () => window.removeEventListener('rv-route-loading', handleRouteLoading);
  }, []);

  const active = Boolean(loading || eventLoading);

  const updatePosition = (clientX: number, clientY: number) => {
    lastPosRef.current = { x: clientX, y: clientY };
    if (!containerRef.current) return;

    // Positionné immédiatement collé sous la pointe droite du curseur
    let posX = clientX + 8;
    let posY = clientY + 10;

    // Éviter le débordement hors de la fenêtre
    if (posX + LOADER_SIZE + 4 > window.innerWidth) {
      posX = clientX - LOADER_SIZE - 4;
    }
    if (posY + LOADER_SIZE + 4 > window.innerHeight) {
      posY = clientY - LOADER_SIZE - 4;
    }

    containerRef.current.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
  };

  // Suivi en continu du pointeur (même inactif) en phase de capture pour avoir instantanément
  // la position exacte lors d'un clic ou d'une reprise
  useEffect(() => {
    const handlePointer = (e: MouseEvent | PointerEvent) => {
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      if (isVisibleRef.current) {
        updatePosition(e.clientX, e.clientY);
      }
    };

    window.addEventListener('pointermove', handlePointer, { capture: true, passive: true });
    window.addEventListener('mousemove', handlePointer, { capture: true, passive: true });
    window.addEventListener('pointerdown', handlePointer, { capture: true, passive: true });

    const handleMouseLeave = () => {
      if (containerRef.current) {
        containerRef.current.style.display = 'none';
      }
    };

    const handleMouseEnter = () => {
      if (containerRef.current && isVisibleRef.current) {
        containerRef.current.style.display = 'block';
      }
    };

    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);

    return () => {
      window.removeEventListener('pointermove', handlePointer, { capture: true });
      window.removeEventListener('mousemove', handlePointer, { capture: true });
      window.removeEventListener('pointerdown', handlePointer, { capture: true });
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
    };
  }, []);

  // Affichage / masquage immédiat synchronisé avec l'état actif
  useEffect(() => {
    isVisibleRef.current = active;

    if (containerRef.current) {
      containerRef.current.style.display = active ? 'block' : 'none';
      if (active && lastPosRef.current) {
        updatePosition(lastPosRef.current.x, lastPosRef.current.y);
      }
    }
  }, [active]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <style>{SPINNER_STYLES}</style>
      <div
        ref={containerRef}
        className="rv-cursor-loader"
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          display: active ? 'block' : 'none',
          pointerEvents: 'none',
          zIndex: 9999999,
          willChange: 'transform',
          userSelect: 'none',
        }}
      >
        <div style={pillStyle}>
          <span style={spinnerStyle} />
        </div>
      </div>
    </>,
    document.body
  );
}

