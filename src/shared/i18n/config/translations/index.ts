import type { AppTranslationPair } from '../types';
import { appTranslationPairs } from './app';
import { authTranslationPairs } from './auth';
import { collabTranslationPairs } from './collab';
import { controlPanelTranslationPairs } from './controlPanel';
import { dashboardTranslationPairs } from './dashboard';
import { fitPredictorTranslationPairs } from './fitPredictor';
import { globalTranslationPairs } from './global';
import { itineraryTranslationPairs } from './itinerary';
import { lidarTranslationPairs } from './lidar';
import { mapTranslationPairs } from './map';
import { projectBrowserTranslationPairs } from './projectBrowser';

// Order matters on a duplicate key (the later pair wins); keep the same order
// as LEADING_FILES + alphabetical in scripts/prebuild-api-i18n.mjs.
export const APP_TRANSLATION_PAIRS: ReadonlyArray<AppTranslationPair> = [
  ...globalTranslationPairs,
  ...projectBrowserTranslationPairs,
  ...controlPanelTranslationPairs,
  ...dashboardTranslationPairs,
  ...appTranslationPairs,
  ...authTranslationPairs,
  ...collabTranslationPairs,
  ...fitPredictorTranslationPairs,
  ...itineraryTranslationPairs,
  ...lidarTranslationPairs,
  ...mapTranslationPairs,
];
