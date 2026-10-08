import { useEffect } from 'react';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { isFreeCamActive } from '@/features/freeCam';

/**
 * Raccourcis clavier qui agissent sur l'itinéraire actif.
 *
 * Écoute au niveau de la fenêtre pour que le raccourci marche quel que soit le
 * focus — que l'utilisateur vienne de cliquer sur un onglet d'itinéraire du
 * panneau de gauche ou sur une ligne du panneau de synthèse central.
 * L'itinéraire actif est la seule source de vérité partagée par les deux
 * panneaux : le supprimer est donc cohérent depuis l'un ou l'autre.
 *
 * Garde-fous :
 *  - ignore les touches pendant la saisie dans des champs input / textarea /
 *    contentEditable (éditer un nom d'itinéraire, une recherche, etc. ne
 *    déclenche donc jamais de suppression) ;
 *  - ignore les appuis qui comportent des touches de modification (les
 *    combinaisons de l'OS / du navigateur comme Maj+Suppr ou Ctrl+Maj+Suppr
 *    gardent leur comportement natif) ;
 *  - ne fait rien quand il n'y a rien à supprimer, ou qu'il ne reste qu'un seul
 *    itinéraire (conforme à la règle `removeItinerary` du store).
 */
export interface UseItineraryDeleteShortcutArgs {
  /** Itinéraire actif, ou null quand aucun n'est sélectionné. */
  activeItineraryId: string | null;
  /** Nombre total d'itinéraires ; la suppression est désactivée quand il est ≤ 1. */
  itineraryCount: number;
  /** Supprime l'itinéraire d'id donné. Renvoie true s'il a été supprimé. */
  onRemove: (id: string) => boolean;
  /** À false, l'écouteur est entièrement détaché. */
  enabled?: boolean;
}

export function useItineraryDeleteShortcut({
  activeItineraryId,
  itineraryCount,
  onRemove,
  enabled = true,
}: UseItineraryDeleteShortcutArgs): void {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ne réagir qu'aux touches Suppr / Retour arrière seules. Toute touche de
      // modification maintenue (Ctrl, Alt, Maj, Méta) laisse la main au navigateur / à l'OS.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      // Ne jamais détourner la saisie de texte.
      if (isTypingTarget(event.target)) return;
      if (isFreeCamActive()) return;

      if (!activeItineraryId || itineraryCount <= 0) return;

      const removed = onRemove(activeItineraryId);
      if (removed) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeItineraryId, itineraryCount, onRemove, enabled]);
}
