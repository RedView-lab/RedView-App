import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { SequencedBatch, Snapshot } from '../../src/features/collab/protocol.ts';

/**
 * Stockage durable d'une salle (comme chez Figma) :
 *  - point de sauvegarde : l'état exact de la salle (objets, positions,
 *    segments ; `Snapshot`) et sa séquence, plus le document matérialisé
 *    pour les lecteurs hors session (navigateur de projets, export) ;
 *  - journal : les lots acceptés au-delà du point de sauvegarde, écrits par
 *    paquets toutes les ~250 ms ; un client garde ses lots tant qu'ils ne
 *    sont pas durables.
 *
 * Reprise : point de sauvegarde + journal au-delà de sa séquence. Le journal
 * est aussi la barrière contre deux serveurs qui tiendraient la même salle
 * (déploiement en recouvrement) : deux paquets ne peuvent pas commencer à la
 * même séquence (`appendJournal` → `conflict`), le second serveur ferme sa
 * salle et ses clients renvoient leurs lots non durables à l'autre.
 */

export interface RoomCheckpoint {
  seq: number;
  snapshot: Snapshot;
  clientSeqs: Record<string, number>;
}

/** Point de sauvegarde à écrire, déjà sérialisé (serialize.ts : incrémental). */
export interface CheckpointWrite {
  seq: number;
  /** JSON d'un `RoomCheckpoint`. */
  checkpointJson: string;
  document: ProjectDocument;
  documentJson: string;
}

export interface LoadedRoom {
  /** Point de sauvegarde exact, s'il correspond au document enregistré. */
  checkpoint: RoomCheckpoint | null;
  /** Document enregistré (repli quand il n'y a pas de point de sauvegarde valable). */
  document: ProjectDocument;
  /** Séquence de départ quand on repart du document. */
  baseSeq: number;
  /** Lots journalisés au-delà du point de sauvegarde, dans l'ordre. */
  journal: SequencedBatch[];
}

export interface ProjectAccess {
  ownerId: string;
  /** Équipe du projet partagé (`p<projectId>`), null s'il ne l'est pas. */
  teamId: string | null;
}

export type AppendResult = 'ok' | 'conflict';

export interface RoomStorage {
  readonly kind: 'appwrite' | 'file';
  /** Propriétaire et équipe du projet ; null : introuvable. */
  access(projectId: string): Promise<ProjectAccess | null>;
  /**
   * État de départ d'une salle. `seed` (développement seulement : projets
   * locaux du compte démo) crée la salle à partir du document du premier client.
   */
  loadRoom(projectId: string, seed?: ProjectDocument): Promise<LoadedRoom | null>;
  appendJournal(projectId: string, batches: readonly SequencedBatch[]): Promise<AppendResult>;
  /** Point de sauvegarde (après un journal à jour jusqu'à `write.seq`). */
  saveCheckpoint(projectId: string, write: CheckpointWrite): Promise<void>;
  /** Retire du journal les paquets entièrement couverts par le point de sauvegarde. */
  pruneJournal(projectId: string, uptoSeq: number): Promise<void>;
}

/** Paquet de journal invalide ou lu dans le désordre : on refuse de charger plutôt que de diverger. */
export function assertContiguous(journal: readonly SequencedBatch[], afterSeq: number): SequencedBatch[] {
  const ordered = [...journal].sort((a, b) => a.seq - b.seq).filter((batch) => batch.seq > afterSeq);
  let expected = afterSeq + 1;
  for (const batch of ordered) {
    if (batch.seq !== expected) throw new Error(`journal discontinu : séquence ${batch.seq} au lieu de ${expected}`);
    expected += 1;
  }
  return ordered;
}
