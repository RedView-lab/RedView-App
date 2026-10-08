// ============================================
// Viewer LiDAR — montage de la couche React des commentaires
// ============================================

import { createRoot } from 'react-dom/client';

import { AppI18nStaticProvider } from '@/shared/i18n/AppI18nProvider';

import { ViewerCommentsUi } from './ViewerCommentsUi';
import type { ViewerComments } from './viewerComments';

/** Monte la couche des commentaires sur le canvas de la scène ; renvoie son démontage. */
export function mountViewerCommentsUi(controller: ViewerComments, container: HTMLElement): () => void {
  const host = document.createElement('div');
  host.className = 'rv-lidar-comments-host';
  container.appendChild(host);
  const root = createRoot(host);
  root.render(
    <AppI18nStaticProvider>
      <ViewerCommentsUi controller={controller} />
    </AppI18nStaticProvider>,
  );
  return () => {
    root.unmount();
    host.remove();
  };
}
