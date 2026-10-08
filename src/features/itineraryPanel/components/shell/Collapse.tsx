import { useEffect, useState, type ReactNode } from 'react';

/**
 * Replie / déplie en douceur ses enfants avec la technique moderne
 * `grid-template-rows: 0fr → 1fr`. Pas de mesure de hauteur en JS, fonctionne
 * avec des contenus de hauteur variable, s'accorde avec la mise en page automatique.
 *
 * Rendu :
 *  - fondu de l'opacité 0 ↔ 1 (180 ms, ease-out)
 *  - la hauteur passe de 0 à la hauteur naturelle (220 ms, cubic-bezier)
 *  - les enfants restent montés pendant l'animation de fermeture, puis sont
 *    démontés pour éviter un focus / un ordre de tabulation périmé dans un bloc de hauteur 0.
 */
interface CollapseProps {
  open: boolean;
  /** className extérieure optionnelle appliquée à l'enveloppe. */
  className?: string;
  /** Durée de l'animation en ms (220 par défaut). */
  duration?: number;
  children: ReactNode;
}

export function Collapse({
  open,
  className,
  duration = 220,
  children,
}: CollapseProps) {
  // Garder les enfants montés pendant l'animation de fermeture. On ne démonte
  // qu'une fois l'enveloppe entièrement repliée.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setMounted(false), duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);

  return (
    <div
      className={`rvi-collapse${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      style={{ ['--rvi-collapse-duration' as never]: `${duration}ms` }}
      aria-hidden={!open}
    >
      <div className="rvi-collapse__inner">
        {mounted ? children : null}
      </div>
    </div>
  );
}
