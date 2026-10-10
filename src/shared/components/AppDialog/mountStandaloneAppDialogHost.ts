import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { AppI18nStaticProvider } from '@/shared/i18n/AppI18nProvider';

import { AppDialogHost } from './AppDialogHost';

let mounted = false;

/**
 * Pages sans App (visualiseur LiDAR, `viewer.html`) : monte une fois l'hôte
 * des pop-ins de `confirmDialog` / `promptDialog` dans sa propre racine React.
 * La page importe elle-même `shared/styles/dialog.css` (comme ses autres
 * feuilles communes) : importée ici, elle devenait un morceau CSS seul.
 */
export function mountStandaloneAppDialogHost(): void {
  if (mounted) return;
  mounted = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  createRoot(container).render(createElement(AppI18nStaticProvider, null, createElement(AppDialogHost)));
}
