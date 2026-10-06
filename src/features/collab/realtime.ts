import type { MotionFields, PresenceUpdate } from './protocol';

/**
 * Ce que la présence en direct (features/livePresence : curseurs, suivre un
 * éditeur, Spotlight) utilise de la session de co-édition, sans dépendre du
 * moteur (chargé à part, à l'ouverture d'une session).
 */

/** Message `motion` d'un autre éditeur, ou son dernier état à l'arrivée dans la salle. */
export interface MotionEvent {
  from: string;
  /** Horodatage de l'émetteur (`performance.now()` de son onglet). */
  t: number;
  fields: MotionFields;
  /**
   * Dernier état connu donné par `welcome` : pas un échantillon en direct (il
   * peut dater), il ne règle pas l'horloge de lecture.
   */
  snapshot: boolean;
}

export interface CollabRealtime {
  readonly clientId: string;
  subscribeMotion(listener: (event: MotionEvent) => void): () => void;
  /** Envoie si la session est en ligne ; rend `false` sinon. */
  sendMotion(t: number, fields: MotionFields): boolean;
  /** Assez de place dans la connexion pour un message éphémère (sinon : sauté, le suivant le remplace). */
  canSendVolatile(): boolean;
  /** Présence de cet éditeur (fusionnée, envoyée au plus à ≈ 10 Hz, redonnée à chaque reconnexion). */
  updatePresence(patch: Partial<PresenceUpdate>): void;
}
