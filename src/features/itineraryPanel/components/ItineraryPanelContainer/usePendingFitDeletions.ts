import { useEffect, useRef } from 'react';

import {
  flushPendingFitDeletions,
  isServerOwnedDocument,
  scheduleFitUploadsDeletion,
} from '@/shared/services/projects';
import type { Itinerary } from '../../types';

/**
 * Fichiers FIT (traces GPS, fréquence cardiaque : RGPD) des itinéraires
 * supprimés. La suppression d'un itinéraire s'annule : ses fichiers restent
 * en attente et sont effacés à la fermeture du projet (changement de projet,
 * démontage, `pagehide`) s'il ne les référence plus (shared/services/projects/fitFiles.ts).
 *
 * Seuls les retraits d'un même projet comptent : un changement de projet
 * remplace toute la liste sans rien supprimer. Rien dans un projet partagé :
 * un autre éditeur peut annuler sa propre suppression, et les fichiers d'un
 * autre éditeur ne sont pas à nous (ils partent avec le projet ou son compte).
 */
export function usePendingFitDeletions(projectId: string | null | undefined, itineraries: readonly Itinerary[]): void {
  // Dernier état vu, par projet : relu au nettoyage, avant que la liste du
  // projet suivant ne le remplace (les nettoyages passent avant les effets).
  const previousRef = useRef({ projectId, itineraries });

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { projectId, itineraries };
    if (!projectId || previous.projectId !== projectId || isServerOwnedDocument(projectId)) return;
    const currentIds = new Set(itineraries.map((itinerary) => itinerary.id));
    for (const itinerary of previous.itineraries) {
      if (!currentIds.has(itinerary.id)) scheduleFitUploadsDeletion(projectId, itinerary.fitUploads ?? []);
    }
  }, [projectId, itineraries]);

  useEffect(() => {
    if (!projectId) return undefined;
    const flush = () => {
      const { projectId: seenProjectId, itineraries: seenItineraries } = previousRef.current;
      if (seenProjectId !== projectId) return;
      void flushPendingFitDeletions(projectId, { itineraries: [...seenItineraries] }).catch((error: unknown) => {
        console.warn('[fit-predictor] failed to delete FIT files of removed itineraries', error);
      });
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [projectId]);
}
