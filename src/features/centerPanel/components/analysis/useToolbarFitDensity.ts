import { useLayoutEffect, type RefObject } from 'react';

/** Plus haute étape de compaction définie dans styles/analysis/responsive.css. */
const MAX_DENSITY = 8;

/** Unités de retour à la ligne : les enfants de la barre d'outils, et les puces du groupe de filtres (il revient à la ligne de lui-même). */
const ITEM_SELECTOR = ':scope > *, :scope > .rvc-center-analysis__filters > *';

/** Vrai quand un élément commence sous le bas d'un autre, c'est-à-dire que la ligne a cassé. */
function wrapsOntoSecondRow(items: readonly Element[]): boolean {
  let firstRowBottom = Infinity;
  const tops: number[] = [];
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // display: none à cette étape
    firstRowBottom = Math.min(firstRowBottom, rect.bottom);
    tops.push(rect.top);
  }
  return tops.some((top) => top >= firstRowBottom - 0.5);
}

/**
 * Garde la barre d'outils de l'analyse sur une ligne : choisit la première étape
 * de compaction dont la mise en page ne revient pas à la ligne, d'après le
 * contenu mesuré plutôt que des points de rupture de la fenêtre, pour tenir
 * quelles que soient la langue, la métrique d'axe ou le libellé de surface.
 * L'étape n est écrite `data-density="1 … n"` pour que le CSS fasse « au moins
 * n » avec `[data-density~='n']`. Au-delà de la dernière étape, la barre revient
 * quand même à la ligne : ses menus déroulants sont positionnés dedans, elle ne
 * peut pas devenir une zone de défilement.
 */
export function useToolbarFitDensity(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const applyDensity = (level: number) => {
      if (level === 0) delete el.dataset.density;
      else el.dataset.density = Array.from({ length: level }, (_, i) => i + 1).join(' ');
    };

    const fit = () => {
      if (el.clientWidth === 0) return; // panneau replié : garder la dernière étape
      const items = Array.from(el.querySelectorAll(ITEM_SELECTOR));
      // Les contrôles animent leur padding : mesurée en pleine transition, une
      // étape serait jugée sur l'espacement de l'étape précédente (data-fitting
      // coupe les transitions, responsive.css).
      el.dataset.fitting = '';
      let level = 0;
      applyDensity(level);
      while (level < MAX_DENSITY && wrapsOntoSecondRow(items)) {
        level += 1;
        applyDensity(level);
      }
      delete el.dataset.fitting;
    };

    fit();

    // Largeur seulement : un changement d'étape modifie la hauteur de la barre, pas sa largeur.
    let lastWidth = el.clientWidth;
    const resizeObserver = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    resizeObserver.observe(el);

    // Les libellés changent de largeur avec la langue, la métrique d'axe ou le choix de surface.
    const mutationObserver = new MutationObserver(fit);
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });

    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) fit();
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [ref]);
}
