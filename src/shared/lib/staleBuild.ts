import { notify } from './notify';

/**
 * Onglet resté ouvert pendant un déploiement : les chunks hashés de son build
 * n'existent plus (404, ou l'index.html de la SPA), donc un import paresseux
 * échoue. Vite le signale par `vite:preloadError` (build seulement).
 *
 * - Un import de navigation (gestionnaire de projets, éditeur : l'utilisateur
 *   attend l'écran) recharge la page une fois, pour récupérer le nouvel
 *   index.html. Le garde (sessionStorage, mémoire en repli) évite les boucles
 *   quand le rechargement ne règle rien (hors ligne, build cassé).
 * - Un import de fond (préchargement au survol, module chargé en cours
 *   d'édition) ne recharge jamais la page sous l'utilisateur : un toast lui
 *   propose de recharger quand il le veut.
 *
 * L'événement n'est jamais annulé : sinon Vite résout l'import en `undefined`
 * et chaque appelant plante sur sa déstructuration au lieu de recevoir l'erreur.
 */

const RELOAD_AT_KEY = 'redview:preload-error-reload-at';
const RELOAD_GUARD_MS = 60_000;
/** Toujours en vie après ce délai : rechargement refusé (« Rester sur la page »). */
const RELOAD_STALL_MS = 3_000;

const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite (feuille de style d'un chunk)
  /is not a valid javascript mime type/i, // chunk remplacé par l'index.html de la SPA
];

/** Erreur d'un chunk introuvable (onglet d'un ancien build, ou connexion coupée). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

type GuardStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Réserve le rechargement si aucun n'a eu lieu depuis `RELOAD_GUARD_MS`.
 * `memory` sert quand le stockage est indisponible (il est alors limité à un
 * rechargement par vie de page, ce qui suffit à éviter la boucle).
 */
export function claimStaleBuildReload(
  storage: GuardStorage | null,
  now: number,
  memory: { lastReloadAt: number },
): boolean {
  let lastReloadAt = memory.lastReloadAt;
  try {
    if (storage) lastReloadAt = Math.max(lastReloadAt, Number(storage.getItem(RELOAD_AT_KEY)) || 0);
  } catch {
    // stockage illisible : la mémoire seule fait le garde
  }
  if (now - lastReloadAt < RELOAD_GUARD_MS) return false;
  memory.lastReloadAt = now;
  try {
    storage?.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    // stockage plein ou interdit : la mémoire seule fait le garde
  }
  return true;
}

let navigationImports = 0;

/**
 * Import attendu par l'écran (sa panne doit recharger la page) : à envelopper
 * autour de l'`import()` d'une route paresseuse. Le compteur est encore levé
 * quand Vite déclenche `vite:preloadError`, puisque l'événement part avant que
 * le rejet n'atteigne ce `finally`.
 */
export function trackNavigationImport<T>(load: Promise<T>): Promise<T> {
  navigationImports += 1;
  return load.finally(() => {
    navigationImports -= 1;
  });
}

let noticeShown = false;

function showStaleBuildNotice(reload: () => void): void {
  if (noticeShown) return;
  noticeShown = true;
  notify.prompt('Une nouvelle version de RedView est en ligne. Rechargez la page pour continuer.', undefined, {
    actionLabel: 'Recharger',
    onAction: reload,
    durationMs: Number.POSITIVE_INFINITY,
  });
}

function readSessionStorage(): GuardStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** À appeler une fois au démarrage (main.tsx). Rend de quoi le retirer (tests). */
export function installStaleBuildRecovery(): () => void {
  const memory = { lastReloadAt: 0 };
  const reload = () => window.location.reload();
  const onPreloadError = () => {
    if (navigationImports === 0) {
      showStaleBuildNotice(reload);
      return;
    }
    if (!claimStaleBuildReload(readSessionStorage(), Date.now(), memory)) {
      // Le rechargement récent n'a rien réglé : l'erreur suit son cours
      // (écran de GlobalErrorBoundary), le toast reste pour réessayer.
      showStaleBuildNotice(reload);
      return;
    }
    reload();
    // Un `beforeunload` (export vidéo, co-édition non synchronisée) peut
    // garder la page : l'utilisateur rechargera quand il voudra.
    window.setTimeout(() => showStaleBuildNotice(reload), RELOAD_STALL_MS);
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
