const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Tab et Maj+Tab restent dans `container` (pop-in `aria-modal`) : à appeler
 * sur chaque `keydown` Tab. Partagé par les pop-ins de l'app (`AppDialog`,
 * résiliation de l'abonnement…).
 */
export function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
    event.preventDefault();
    first.focus();
  }
}
