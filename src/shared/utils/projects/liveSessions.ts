/**
 * Projets ouverts en co-édition (features/collab) : leur document partagé est
 * écrit par le serveur temps réel, jamais par l'autosave de l'application.
 * Un client qui réécrirait `projects.data` d'un projet partagé écraserait le
 * travail des autres (et le point de sauvegarde du serveur ne correspondrait
 * plus). La copie locale (IndexedDB) continue, elle, d'être écrite.
 *
 * Inscrit à la création de la session (en ligne ou non), retiré à sa fin.
 */
const live = new Map<string, number>();

/** Marque le projet comme géré par une session ; renvoie la fonction qui l'en retire. */
export function registerLiveSession(projectId: string): () => void {
  live.set(projectId, (live.get(projectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (live.get(projectId) ?? 1) - 1;
    if (count > 0) live.set(projectId, count);
    else live.delete(projectId);
  };
}

export function isLiveSession(projectId: string): boolean {
  return live.has(projectId);
}

/**
 * Équipe d'un projet partagé, même règle que le serveur (`projectTeamId`,
 * api/_lib/projectSharing.ts) ; null pour un id trop long (haché côté serveur).
 */
export function sharedProjectTeamId(projectId: string): string | null {
  const id = `p${projectId}`;
  return id.length <= 36 ? id : null;
}
