/**
 * Chunk de l'éditeur 3D (carte Mapbox, LiDAR, panneaux) : chargé à la demande
 * pour que le gestionnaire de projets s'affiche sans lui
 * (scripts/quality/check-bundle.mjs le vérifie), et préchargé dès qu'un projet
 * est visé (survol, focus, ouverture) ou que le navigateur est au repos.
 */
type EditorModule = typeof import('./components/DashboardEditor');

let editorModule: Promise<EditorModule> | null = null;

export function loadDashboardEditor(): Promise<EditorModule> {
  editorModule ??= import('./components/DashboardEditor').catch((error: unknown) => {
    // Échec réseau : la prochaine demande retente. Un chunk d'un ancien build
    // recharge la page si l'éditeur est attendu (ouverture), sinon un toast le
    // propose (préchargement) : shared/lib/staleBuild.ts.
    editorModule = null;
    throw error;
  });
  return editorModule;
}

/** Précharge l'éditeur sans attendre ni propager d'erreur. */
export function prefetchDashboardEditor(): void {
  loadDashboardEditor().catch(() => undefined);
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Précharge l'éditeur quand le navigateur est au repos (gestionnaire affiché),
 * sauf en mode « économie de données ». Renvoie l'annulation.
 */
export function prefetchDashboardEditorWhenIdle(): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => undefined;
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(prefetchDashboardEditor, { timeout: 4000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(prefetchDashboardEditor, 1500);
  return () => window.clearTimeout(timer);
}
