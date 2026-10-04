// Mise en page du dashboard pour le workbench : les vrais modules de l'app,
// bundlés tels quels par esbuild (build.mjs), aucune recopie. Le plugin de
// build rend seulement les paramètres de l'échelle Retina réglables
// (`__wbSetScaleParams`) et l'échelle forçable (`__wbForceScale`).
export {
  computeAppScale,
  supportsStandardZoom,
  APP_SCALE_DESIGN_WIDTH,
  APP_SCALE_DESIGN_HEIGHT,
} from '@/shared/lib/appScale';
export * as scaleModule from '@/shared/lib/appScale';
export { getDashboardLayout } from '@/pages/Dashboard/lib/layout';
export { getDashboardStyles } from '@/pages/Dashboard/lib/dashboardStyles';
export * as C from '@/pages/Dashboard/lib/constants';
export { PLACE_SEARCH_TIGHT_WIDTH, PLACE_SEARCH_ICONS_WIDTH } from '@/pages/Dashboard/components/DashboardPlaceSearch.constants';
