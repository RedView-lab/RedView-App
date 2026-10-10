import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';

import { getCurrentAppDialog, subscribeAppDialog } from '@/shared/lib/appDialog';

const loadHost = () => import('./AppDialogHost');
const AppDialogHost = lazy(() => loadHost().then((module) => ({ default: module.AppDialogHost })));

const isPending = () => getCurrentAppDialog() !== null;

/**
 * Monté une fois dans App : rend `AppDialogHost` quand une pop-in de
 * `confirmDialog` / `promptDialog` est demandée. L'hôte est chargé à part
 * (préchargé quand le navigateur est inactif) : il reste hors du chemin
 * critique du gestionnaire de projets (`npm run bundle:check`).
 */
export function AppDialogGate() {
  const pending = useSyncExternalStore(subscribeAppDialog, isPending, () => false);

  useEffect(() => {
    if (typeof window.requestIdleCallback !== 'function') return;
    const handle = window.requestIdleCallback(() => void loadHost().catch(() => undefined), { timeout: 10_000 });
    return () => window.cancelIdleCallback(handle);
  }, []);

  return pending ? (
    <Suspense fallback={null}>
      <AppDialogHost />
    </Suspense>
  ) : null;
}
