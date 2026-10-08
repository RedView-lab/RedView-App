import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import '../ChartZoomNavigator.css';

export interface ChartZoomNavigatorProps {
  orientation: 'horizontal' | 'vertical';
  /** Part du domaine complet visible dans la fenêtre : [minFraction, 1.0] */
  visibleFraction: number;
  /** Décalage normalisé de la fenêtre visible : [0.0, 1.0] */
  offset: number;
  onChange: (next: { visibleFraction: number; offset: number }) => void;
  className?: string;
  minFraction?: number;
  ariaLabel?: string;
  startHandleTitle?: string;
  endHandleTitle?: string;
  onWheel?: (e: ReactWheelEvent<HTMLDivElement>) => void;
  /**
   * Gestionnaire de double-clic. S'il est omis, le double-clic émet une vue
   * complète ({ visibleFraction: 1, offset: 0 }) via `onChange`, impossible à
   * distinguer d'une poignée glissée jusqu'au bord.
   */
  onReset?: () => void;
}

type DragMode = 'body' | 'start' | 'end';

/**
 * Barre de zoom et de déplacement façon Premiere Pro.
 * - Glisser le corps central déplace la fenêtre visible.
 * - Glisser les poignées de début/fin zoome ou dézoome.
 * - Cliquer sur la piste centre sur cette position.
 * - Double-cliquer revient à la vue complète à 100 %.
 */
export function ChartZoomNavigator({
  orientation,
  visibleFraction,
  offset,
  onChange,
  className = '',
  minFraction = 0.04,
  ariaLabel,
  startHandleTitle,
  endHandleTitle,
  onWheel,
  onReset,
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

  // Dans l'intervalle normalisé [0, 1] :
  // À l'horizontale : début = 0 (gauche), fin = 1 (droite)
  // À la verticale : le rapport 0 est en bas (altitude min), 1 en haut (altitude max)
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

    // Les événements de pointeur peuvent arriver plusieurs fois par image
    // (souris à haute fréquence) : émettre au plus un changement de vue par
    // image d'animation, le dernier l'emporte.
    let frameId: number | null = null;
    let pending: { visibleFraction: number; offset: number } | null = null;
    const flush = () => {
      frameId = null;
      const next = pending;
      pending = null;
      if (next) onChangeRef.current(next);
    };
    const emit = (next: { visibleFraction: number; offset: number }) => {
      pending = next;
      if (frameId === null) frameId = window.requestAnimationFrame(flush);
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;
      e.preventDefault();

      const currentCoord = isH ? e.clientX : e.clientY;
      const deltaPx = currentCoord - session.startCoord;

      // À la verticale : un mouvement vers le bas (deltaPx > 0) fait baisser l'altitude
      const deltaRatio = isH
        ? deltaPx / session.trackPx
        : -deltaPx / session.trackPx;

      const { mode, initialStartRatio, initialEndRatio } = session;
      const initialSpan = initialEndRatio - initialStartRatio;

      if (mode === 'body') {
        let nextStart = initialStartRatio + deltaRatio;
        nextStart = Math.max(0, Math.min(1 - initialSpan, nextStart));
        const nextOffset = initialSpan >= 0.999 ? 0 : nextStart / (1 - initialSpan);
        emit({ visibleFraction: initialSpan, offset: Math.max(0, Math.min(1, nextOffset)) });
      } else if (mode === 'start') {
        let nextStart = initialStartRatio + deltaRatio;
        nextStart = Math.max(0, Math.min(initialEndRatio - minFraction, nextStart));
        const nextSpan = initialEndRatio - nextStart;
        const nextOffset = nextSpan >= 0.999 ? 0 : nextStart / (1 - nextSpan);
        emit({
          visibleFraction: Math.max(minFraction, Math.min(1, nextSpan)),
          offset: Math.max(0, Math.min(1, nextOffset)),
        });
      } else if (mode === 'end') {
        let nextEnd = initialEndRatio + deltaRatio;
        nextEnd = Math.max(initialStartRatio + minFraction, Math.min(1, nextEnd));
        const nextSpan = nextEnd - initialStartRatio;
        const nextOffset = nextSpan >= 0.999 ? 0 : initialStartRatio / (1 - nextSpan);
        emit({
          visibleFraction: Math.max(minFraction, Math.min(1, nextSpan)),
          offset: Math.max(0, Math.min(1, nextOffset)),
        });
      }
    };

    const handleWindowPointerUp = () => {
      // Valider la dernière position de façon synchrone pour que le lâcher soit exact.
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      flush();
      dragSessionRef.current = null;
      setActiveDrag(null);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
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
    if (onReset) {
      onReset();
      return;
    }
    // Revenir à la vue complète à 100 %
    onChange({ visibleFraction: 1, offset: 0 });
  };

  // Calculs géométriques
  const thumbStyle: React.CSSProperties = isH
    ? {
        left: `${(startRatio * 100).toFixed(4)}%`,
        width: `${(clampedFraction * 100).toFixed(4)}%`,
      }
    : {
        // En Y écran : 0 est en haut, height en bas
        // Haut du curseur = 1 - endRatio
        top: `${((1 - endRatio) * 100).toFixed(4)}%`,
        height: `${(clampedFraction * 100).toFixed(4)}%`,
      };

  return (
    <div
      ref={trackRef}
      className={`rvc-zoom-bar rvc-zoom-bar--${orientation} ${className}${activeDrag ? ' is-dragging' : ''}`}
      onPointerDown={handleTrackClick}
      onDoubleClick={handleDoubleClick}
      onWheel={onWheel}
      role="scrollbar"
      aria-label={ariaLabel ?? (isH ? 'Zoom et défilement horizontal' : 'Zoom et défilement vertical')}
      aria-valuenow={Math.round(clampedOffset * 100)}
    >
      <div
        className={`rvc-zoom-bar__thumb${activeDrag ? ' is-active' : ''}`}
        style={thumbStyle}
        onPointerDown={(e) => handlePointerDown('body', e)}
      >
        {/* Poignée de début (gauche en H, bas en V) */}
        <div
          className={`rvc-zoom-bar__handle rvc-zoom-bar__handle--${isH ? 'left' : 'bottom'}`}
          onPointerDown={(e) => handlePointerDown('start', e)}
          title={startHandleTitle ?? (isH ? 'Ajuster début' : 'Ajuster plancher')}
        />

        {/* Points centraux */}
        <div className="rvc-zoom-bar__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        {/* Poignée de fin (droite en H, haut en V) */}
        <div
          className={`rvc-zoom-bar__handle rvc-zoom-bar__handle--${isH ? 'right' : 'top'}`}
          onPointerDown={(e) => handlePointerDown('end', e)}
          title={endHandleTitle ?? (isH ? 'Ajuster fin' : 'Ajuster plafond')}
        />
      </div>
    </div>
  );
}
