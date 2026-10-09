import type { AppTranslationPair } from '../types';
import { appTranslationPairs } from './app';
import { authTranslationPairs } from './auth';
import { collabTranslationPairs } from './collab';
import { commentsTranslationPairs } from './comments';
import { controlPanelTranslationPairs } from './controlPanel';
import { creditsTranslationPairs } from './credits';
import { dashboardTranslationPairs } from './dashboard';
import { fitPredictorTranslationPairs } from './fitPredictor';
import { globalTranslationPairs } from './global';
import { itineraryTranslationPairs } from './itinerary';
import { lidarTranslationPairs } from './lidar';
import { mapTranslationPairs } from './map';
import { projectBrowserTranslationPairs } from './projectBrowser';

// L'ordre compte en cas de clé en double (la paire la plus tardive l'emporte) ;
// garder le même ordre que LEADING_FILES + alphabétique dans scripts/build/prebuild-api-i18n.mjs.
export const APP_TRANSLATION_PAIRS: ReadonlyArray<AppTranslationPair> = [
  ...globalTranslationPairs,
  ...projectBrowserTranslationPairs,
  ...controlPanelTranslationPairs,
  ...dashboardTranslationPairs,
  ...appTranslationPairs,
  ...authTranslationPairs,
  ...collabTranslationPairs,
  ...commentsTranslationPairs,
  ...creditsTranslationPairs,
  ...fitPredictorTranslationPairs,
  ...itineraryTranslationPairs,
  ...lidarTranslationPairs,
  ...mapTranslationPairs,
];
