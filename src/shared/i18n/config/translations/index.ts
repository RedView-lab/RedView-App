import type { AppTranslationPair } from '../types';
import { controlPanelTranslationPairs } from './controlPanel';
import { dashboardTranslationPairs } from './dashboard';
import { globalTranslationPairs } from './global';
import { projectBrowserTranslationPairs } from './projectBrowser';

export const APP_TRANSLATION_PAIRS: ReadonlyArray<AppTranslationPair> = [
  ...globalTranslationPairs,
  ...projectBrowserTranslationPairs,
  ...controlPanelTranslationPairs,
  ...dashboardTranslationPairs,
];
