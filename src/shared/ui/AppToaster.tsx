import { Toaster } from 'sonner';

import './toast.css';

/**
 * Pile des toasts (`notify`), montée une fois par App. Rendu sans le style
 * de sonner (classes `.rv-toast`, jetons du thème) et dans une couche à la
 * densité du dashboard (`.rv-app-scaled-layer`, src/index.css).
 */
export function AppToaster() {
  return (
    <div className="rv-app-scaled-layer rv-toast-layer">
      <Toaster
        position="bottom-right"
        offset={28}
        gap={10}
        duration={2600}
        visibleToasts={3}
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: 'rv-toast',
            success: 'rv-toast--success',
            error: 'rv-toast--error',
            info: 'rv-toast--info',
            title: 'rv-toast__title',
            icon: 'rv-toast__icon',
          },
        }}
      />
    </div>
  );
}
