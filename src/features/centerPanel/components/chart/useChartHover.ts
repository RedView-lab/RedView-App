import { useEffect, useRef, useState } from 'react';

export interface ChartHoverState {
  x: number;
  y: number;
  /** Position horizontale normalisée dans le graphique [0, 1]. */
  ratioX: number;
}

const HOVER_POSITION_EPSILON_PX = 0.5;
const HOVER_RATIO_EPSILON = 1e-4;

function sameHoverState(left: ChartHoverState | null, right: ChartHoverState | null): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.x - right.x) <= HOVER_POSITION_EPSILON_PX &&
    Math.abs(left.y - right.y) <= HOVER_POSITION_EPSILON_PX &&
    Math.abs(left.ratioX - right.ratioX) <= HOVER_RATIO_EPSILON
  );
}

/**
 * Suit la position du pointeur sur un élément conteneur de graphique.
 * Renvoie une ref à attacher au conteneur, et l'état de survol courant
 * (ou null quand le pointeur est dehors).
 *
 * L'élément conteneur est la seule source de vérité des événements de pointeur :
 * toutes les couches visuelles au-dessus doivent avoir `pointer-events: none`.
 */
export function useChartHover<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const lastHoverRef = useRef<ChartHoverState | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Regrouper les événements de pointeur en un commit React par image ; la
    // lecture de mise en page (getBoundingClientRect) se fait aussi au plus une fois par image.
    let rafId: number | null = null;
    let pendingPointer: { clientX: number; clientY: number } | null = null;

    const commitHover = (nextHover: ChartHoverState | null) => {
      if (sameHoverState(lastHoverRef.current, nextHover)) return;
      lastHoverRef.current = nextHover;
      setHover(nextHover);
    };

    const flush = () => {
      rafId = null;
      const pointer = pendingPointer;
      pendingPointer = null;
      if (!pointer) return;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        commitHover(null);
        return;
      }

      const rawX = pointer.clientX - rect.left;
      const rawY = pointer.clientY - rect.top;
      if (rawX < 0 || rawX > rect.width || rawY < 0 || rawY > rect.height) {
        commitHover(null);
        return;
      }

      const x = Math.max(0, Math.min(rect.width, rawX));
      const y = Math.max(0, Math.min(rect.height, rawY));
      const ratioX = rect.width > 0 ? x / rect.width : 0;

      commitHover({ x, y, ratioX });
    };

    const update = (event: PointerEvent) => {
      pendingPointer = { clientX: event.clientX, clientY: event.clientY };
      if (rafId === null) rafId = window.requestAnimationFrame(flush);
    };

    const clear = () => {
      pendingPointer = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      commitHover(null);
    };

    el.addEventListener('pointermove', update, { passive: true });
    el.addEventListener('pointerenter', update, { passive: true });
    el.addEventListener('pointerdown', update, { passive: true });
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointercancel', clear);

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      el.removeEventListener('pointermove', update);
      el.removeEventListener('pointerenter', update);
      el.removeEventListener('pointerdown', update);
      el.removeEventListener('pointerleave', clear);
      el.removeEventListener('pointercancel', clear);
    };
  }, []);

  return { ref, hover } as const;
}
