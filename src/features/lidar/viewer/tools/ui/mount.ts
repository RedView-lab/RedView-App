// ============================================
// LiDAR viewer tools — React layer mount
// ============================================

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ToolsUiActions, ToolsUiStore } from './toolsUiStore';
import { ViewerToolsUi } from './ViewerToolsUi';

/** Mounts the tools' React layer on <body>; returns its unmount. */
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
