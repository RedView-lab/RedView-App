/**
 * Projets dont le document partagé est écrit par le serveur temps réel
 * (features/collab), jamais par l'autosave de l'application :
 *  - en session de co-édition (inscrit à la création de la session, en ligne
 *    ou non, retiré à sa fin) ;
 *  - partagés (équipe connue : `team_id` de la ligne cloud ou de la copie
 *    locale), même hors session — une copie locale réenvoyée au cloud
 *    écraserait le travail des autres (et le point de sauvegarde du serveur
 *    ne correspondrait plus).
 * Pour ces projets, la copie locale (IndexedDB) est écrite mais jamais
 * `dirty`, n'entre jamais en conflit et n'est jamais réenvoyée.
 */
const live = new Map<string, number>();
const shared = new Set<string>();

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

/** Projet partagé (équipe) vu par ce client : lu sur les lignes cloud / locales. */
export function markSharedProject(projectId: string, teamId: string | null | undefined): void {
  if (teamId) shared.add(projectId);
}

export function isSharedProject(projectId: string): boolean {
  return shared.has(projectId);
}

/** Document écrit par le serveur temps réel : ni écriture cloud, ni copie `dirty`, ni conflit. */
export function isServerOwnedDocument(projectId: string): boolean {
  return live.has(projectId) || shared.has(projectId);
}

/**
 * Équipe d'un projet partagé, même règle que le serveur (`projectTeamId`,
 * api/_lib/projectSharing.ts) ; null pour un id trop long (haché côté serveur).
 */
export function sharedProjectTeamId(projectId: string): string | null {
  const id = `p${projectId}`;
  return id.length <= 36 ? id : null;
}
