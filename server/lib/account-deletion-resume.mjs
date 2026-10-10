// ---------------------------------------------------------------------------
// Reprise des suppressions de compte en attente (A14-1, audit du 2026-10-10).
//
// La route de suppression répond 202 dès que le compte est bloqué et inscrit
// au registre `account_deletions`, puis purge en tâche de fond. Un
// redéploiement (SIGTERM du conteneur) coupe cette purge, et ses reprises ne
// vivent que dans le processus : le compte resterait bloqué et marqué
// `deletionpending` jusqu'à un `account-deletions.ts --resume` à la main. Le
// serveur de l'app relance donc, peu après son démarrage puis à intervalle
// régulier, les suppressions en attente depuis plus de 15 min
// (`resumePendingAccountDeletions` de api/auth/delete-account.ts, idempotent).
//
// Seulement dans l'image de production : REDVIEW_RESUME_ACCOUNT_DELETIONS=on
// n'est posé que par le Dockerfile. Un banc qui lance dist-server avec la
// vraie clé (--env-file) ne doit jamais reprendre de vraies suppressions.
// ---------------------------------------------------------------------------

export const ACCOUNT_DELETION_RESUME_DEFAULTS = Object.freeze({
  /** Premier passage : le serveur a fini de démarrer, l'ancien conteneur est arrêté. */
  firstDelayMs: 60_000,
  intervalMs: 15 * 60_000,
});

/** Vrai seulement en production, avec la clé d'API et la variable posée par l'image. */
export function accountDeletionResumeEnabled(env) {
  return env.NODE_ENV === 'production'
    && env.REDVIEW_RESUME_ACCOUNT_DELETIONS === 'on'
    && Boolean(env.APPWRITE_API_KEY);
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   loadResume: () => Promise<((now?: number) => Promise<unknown>) | null | undefined>,
 *   report: (error: unknown) => void,
 *   firstDelayMs?: number,
 *   intervalMs?: number,
 * }} options
 * @returns {() => void} arrêt (tests)
 */
export function startAccountDeletionResume({
  env,
  loadResume,
  report,
  firstDelayMs = ACCOUNT_DELETION_RESUME_DEFAULTS.firstDelayMs,
  intervalMs = ACCOUNT_DELETION_RESUME_DEFAULTS.intervalMs,
}) {
  if (!accountDeletionResumeEnabled(env)) return () => {};
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const resume = await loadResume();
      if (typeof resume !== 'function') throw new Error('[account-deletion-resume] resumePendingAccountDeletions introuvable');
      await resume();
    } catch (error) {
      report(error);
    } finally {
      running = false;
    }
  };
  let interval = null;
  const first = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), intervalMs);
    interval.unref?.();
  }, firstDelayMs);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
