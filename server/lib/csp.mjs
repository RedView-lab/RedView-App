// Content-Security-Policy de l'application (pages HTML et scripts de workers),
// posée par server.mjs. Tout nouvel hôte externe que le navigateur contacte
// (tuiles, API) s'ajoute ici.
//
// Pas de 'unsafe-inline' pour les scripts (aucun script inline dans index.html
// ni viewer.html) ni de 'unsafe-eval' : rien dans l'app n'évalue de code (laz-perf
// est compilé sans génération de code, embind en fermetures), le WebAssembly
// n'a besoin que de 'wasm-unsafe-eval' (Chrome 97, Firefox 102, Safari 16 —
// données MDN). `npm run bench:lidar-engines` sert le viewer avec cette
// politique dans Chromium et Firefox et échoue sur toute violation.

// Point « security » de GlitchTip (errors.redview.tech, projet 1) : la clé est
// celle, publique, du DSN du front (src/main.tsx). Une violation y devient une
// issue : une ressource bloquée en production se voit au lieu de casser en silence.
export const CSP_REPORT_URI = 'https://errors.redview.tech/api/1/security/?glitchtip_key=560280d647da4557b67bd2e937b5893f';

const GEO_SOURCES = 'https://s3.amazonaws.com/elevation-tiles-prod/ https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com https://kanagawa-pointcloud.s3.ap-northeast-1.amazonaws.com https://gsvrg.ipri.aist.go.jp';
const NATIONAL_SOURCES = 'https://data.geopf.fr https://*.geopf.fr https://data.geo.admin.ch https://*.geo.admin.ch https://*.admin.ch https://servicios.idee.es https://*.idee.es https://www.ign.es https://*.ign.es https://hoydedata.no https://*.hoydedata.no https://cyberjapandata.gsi.go.jp https://*.gsi.go.jp https://server.arcgisonline.com https://*.arcgisonline.com https://service.pdok.nl https://geo.api.vlaanderen.be https://remotesensing.vlaanderen.be';

/**
 * @param {{ reportUri?: string | null, upgradeInsecureRequests?: boolean }} [options]
 *   `reportUri: null` et `upgradeInsecureRequests: false` servent aux bancs
 *   locaux en http (rien envoyé à GlitchTip, pas de passage forcé en https).
 */
export function buildCspHeader({ reportUri = CSP_REPORT_URI, upgradeInsecureRequests = true } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob: https://api.mapbox.com https://js.stripe.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://api.mapbox.com",
    "font-src 'self' data:",
    `img-src 'self' data: blob: https://appwrite.redview.tech https://*.tilecache.rainviewer.com https://*.rainviewer.com https://*.rainviewer.net https://api.mapbox.com https://*.mapbox.com ${GEO_SOURCES} ${NATIONAL_SOURCES}`,
    `connect-src 'self' blob: data: wss://app.redview.tech wss://redview.tech https://appwrite.redview.tech https://errors.redview.tech https://api.stripe.com https://api.mapbox.com https://events.mapbox.com https://*.mapbox.com https://*.rainviewer.com https://*.rainviewer.net https://nominatim.openstreetmap.org ${GEO_SOURCES} https://opentopography.s3.sdsc.edu ${NATIONAL_SOURCES}`,
    'frame-src https://js.stripe.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgradeInsecureRequests ? ['upgrade-insecure-requests'] : []),
    ...(reportUri ? [`report-uri ${reportUri}`] : []),
  ].join('; ');
}

export const REDVIEW_CSP_HEADER = buildCspHeader();
