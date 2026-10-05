import type { ProjectDocument } from '../../lib/project/layers';

/**
 * Contrat entre le ProjectStore et une session de co-édition (implémentée par
 * features/collab, sans que le store dépende du moteur de synchronisation).
 *
 * Le store se branche (`bind`) dès que la session existe, sans attendre l'état
 * du serveur : ce qu'il affiche et ce qui s'y écrit pendant la connexion fait
 * partie de la session (rien n'est perdu au premier état reçu). Ensuite, il
 * envoie chaque document produit localement (`pushLocalDocument`) et applique
 * ceux qui viennent d'ailleurs (état du serveur, autres éditeurs,
 * annuler/rétablir de la session), recomposés avec la vue et le travail local
 * de cet appareil. Pendant une session, annuler/rétablir passent par la
 * session : chacun n'annule que ses propres modifications.
 */

/** Résultats dérivés d'un itinéraire, calculés par un seul éditeur. */
export type DerivedKind = 'route' | 'prediction' | 'poi';

/**
 * Qui calcule un résultat dérivé (tracé BRouter, prédiction, recherche POI)
 * quand plusieurs éditeurs ont le projet ouvert : l'auteur de la modification
 * qui l'a rendu périmé, sinon un seul éditeur désigné. Hors session : toujours
 * cet appareil.
 */
export interface DerivedComputeGate {
  /** Cet appareil doit-il calculer `kind` pour cet itinéraire maintenant ? */
  shouldCompute(kind: DerivedKind, itineraryId: string): boolean;
  /** Annonce un calcul en cours (les autres l'attendent) ; renvoie sa fin. */
  beginCompute(kind: DerivedKind, itineraryId: string): () => void;
  /** Prévient quand `shouldCompute` peut avoir changé (éditeur parti, délai écoulé…). */
  subscribe(listener: () => void): () => void;
}

const noop = () => undefined;

export const SOLO_COMPUTE_GATE: DerivedComputeGate = {
  shouldCompute: () => true,
  beginCompute: () => noop,
  subscribe: () => noop,
};

/**
 * Projet partagé dont la session se prépare (module en chargement) : rien
 * n'est calculé sur le document d'ouverture, qui peut dater du dernier point
 * de sauvegarde. La porte de la session prend le relais.
 */
export const SESSION_PENDING_COMPUTE_GATE: DerivedComputeGate = {
  shouldCompute: () => false,
  beginCompute: () => noop,
  subscribe: () => noop,
};

/** Origine d'un document appliqué depuis la session. */
export type CollabChangeCause = 'remote' | 'undo' | 'redo';

/** Nature d'une modification locale envoyée à la session. */
export type CollabLocalChange =
  /** Action de l'utilisateur, regroupée avec ses voisines pour annuler. */
  | 'user'
  /** Action de l'utilisateur formant à elle seule une étape d'annulation. */
  | 'step'
  /** Résultat calculé (routage, altimétrie, POI, prédiction) : rattaché à l'action qui l'a provoqué. */
  | 'background'
  /**
   * Commentaire (features/comments) : envoyé même avant le premier état du
   * serveur, jamais une étape d'annulation (comme chez Figma).
   */
  | 'comment';

/** Écriture faite avant le branchement à la session (rejouée par `bind`). */
export interface PreSessionChange {
  document: ProjectDocument;
  change: CollabLocalChange;
}

export interface ProjectCollabLink {
  /**
   * Branche le store (une fois ; les appels suivants renvoient le document
   * courant) : `base` est le document qu'il affichait au départ, `changes`
   * ses écritures depuis, dans l'ordre. Renvoie le document à afficher.
   */
  bind(base: ProjectDocument, changes: readonly PreSessionChange[]): ProjectDocument;
  /** Document courant de la session (après `bind`). */
  getDocument(): ProjectDocument;
  pushLocalDocument(document: ProjectDocument, change: CollabLocalChange): void;
  subscribe(listener: (document: ProjectDocument, cause: CollabChangeCause) => void): () => void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribeHistory(listener: () => void): () => void;
  computeGate: DerivedComputeGate;
}
