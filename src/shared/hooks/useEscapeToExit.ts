import { useEffect, useRef } from 'react';
import { shouldExitModeOnEscape } from '@/shared/lib/escapeToExit';

/**
 * Échap quitte le mode tant qu'il est `active` (outils de la carte : Tracer,
 * Découper, Fusionner, placement…), comme la FreeCam, le suivi d'un éditeur ou
 * le mode commentaire. Écoute en bouillonnement sur `window`, donc après les
 * menus et gestes en cours, qui gardent la priorité en appelant
 * `preventDefault` (règle : `shouldExitModeOnEscape`).
 */
export function useEscapeToExit(active: boolean, exit: () => void): void {
  const exitRef = useRef(exit);
  useEffect(() => {
    exitRef.current = exit;
  });

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldExitModeOnEscape(event)) return;
      event.preventDefault();
      exitRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);
}
