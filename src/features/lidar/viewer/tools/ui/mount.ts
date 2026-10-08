// ============================================
// Outils du viewer LiDAR — montage de la couche React
// ============================================

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ToolsUiActions, ToolsUiStore } from './toolsUiStore';
import { ViewerToolsUi } from './ViewerToolsUi';

/** Monte la couche React des outils sur <body> ; renvoie son démontage. */
export function mountViewerToolsUi(store: ToolsUiStore, actions: ToolsUiActions): () => void {
  const host = document.createElement('div');
  host.className = 'rv-lidar-tools-ui';
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(ViewerToolsUi, { store, actions }));
  return () => {
    root.unmount();
    host.remove();
  };
}
