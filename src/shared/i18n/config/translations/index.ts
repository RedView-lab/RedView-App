import type { AppTranslationPair } from '../types';
import { appTranslationPairs } from './app';
import { authTranslationPairs } from './auth';
import { collabTranslationPairs } from './collab';
import { creditsTranslationPairs } from './credits';
import { globalTranslationPairs } from './global';
import { itineraryTranslationPairs } from './itinerary';
import { projectBrowserTranslationPairs } from './projectBrowser';

/**
 * Paires livrées au chargement : tout texte affiché sans l'éditeur 3D
 * (connexion, gestionnaire de projets et ses onglets, partage, pages d'erreur,
 * projet créé depuis le gestionnaire). Les fichiers de l'éditeur et du
 * visualiseur LiDAR (controlPanel, dashboard, comments, fitPredictor, lidar,
 * map) arrivent avec leur code : ../registerEditorTranslations.ts.
 * `npm run bundle:check` échoue si un texte d'un module chargé sans l'éditeur
 * n'a sa paire que dans l'un d'eux.
 *
 * Une même clé ne peut pas avoir deux traductions (`npm run i18n:check`) :
 * l'ordre des fichiers ne change rien.
 */
export const APP_SHELL_TRANSLATION_PAIRS: ReadonlyArray<AppTranslationPair> = [
  ...globalTranslationPairs,
  ...projectBrowserTranslationPairs,
  ...appTranslationPairs,
  ...authTranslationPairs,
  ...collabTranslationPairs,
  ...creditsTranslationPairs,
  ...itineraryTranslationPairs,
];
