import { registerAppTranslationPairs } from './bundle';
import { commentsTranslationPairs } from './translations/comments';
import { controlPanelTranslationPairs } from './translations/controlPanel';
import { dashboardTranslationPairs } from './translations/dashboard';
import { fitPredictorTranslationPairs } from './translations/fitPredictor';
import { lidarTranslationPairs } from './translations/lidar';
import { mapTranslationPairs } from './translations/map';

/**
 * Paires de l'éditeur 3D et du visualiseur LiDAR, enregistrées à l'import de
 * ce module. Premier import de leurs points d'entrée (DashboardEditor.tsx,
 * lidar/viewer/main.ts) : évalué avant tout module qui traduit.
 */
registerAppTranslationPairs([
  ...controlPanelTranslationPairs,
  ...dashboardTranslationPairs,
  ...commentsTranslationPairs,
  ...fitPredictorTranslationPairs,
  ...lidarTranslationPairs,
  ...mapTranslationPairs,
]);
