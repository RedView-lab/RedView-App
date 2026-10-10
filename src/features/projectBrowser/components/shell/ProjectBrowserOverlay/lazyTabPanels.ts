import { lazy } from 'react';

import { trackNavigationImport } from '@/shared/lib/staleBuild';

/**
 * Onglets Compte, Abonnement et Réglages du gestionnaire de projets : chargés
 * à leur ouverture, préchargés quand le navigateur est au repos. Ils ne sont
 * pas sur le chemin critique (scripts/quality/check-bundle.mjs) : l'écran
 * d'arrivée est la liste des projets.
 */
const loadAccountPanel = () => import('../../../account/components');
const loadSubscriptionPanel = () => import('../../subscription');
const loadSettingsPanel = () => import('../../../settings');

export const AccountPanel = lazy(() =>
  trackNavigationImport(loadAccountPanel()).then((m) => ({ default: m.AccountPanel })),
);
export const SubscriptionPanel = lazy(() =>
  trackNavigationImport(loadSubscriptionPanel()).then((m) => ({ default: m.SubscriptionPanel })),
);
export const SettingsPanel = lazy(() =>
  trackNavigationImport(loadSettingsPanel()).then((m) => ({ default: m.SettingsPanel })),
);

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function prefetchTabPanels(): void {
  // Préchargement de fond : une erreur (ancien build, hors ligne) est retentée
  // par l'import paresseux à l'ouverture de l'onglet.
  for (const load of [loadAccountPanel, loadSubscriptionPanel, loadSettingsPanel]) {
    load().catch(() => undefined);
  }
}

/** Précharge les onglets secondaires au repos, sauf en « économie de données ». Renvoie l'annulation. */
export function prefetchTabPanelsWhenIdle(): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => undefined;
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(prefetchTabPanels, { timeout: 6000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(prefetchTabPanels, 2500);
  return () => window.clearTimeout(timer);
}
