// ---------------------------------------------------------------------------
// Handler des tuiles radar (Service Worker)
// Les tuiles /radar-tiles/{z}/{x}/{y} du radar européen EUMETNET OPERA sont
// fabriquées par le serveur (server/lib/opera-radar.mjs : lecture du composite,
// reprojection, palette de l'utilisateur) ; le Service Worker les lui relaie.
// Un fetch émis par le Service Worker ne repasse pas par son propre handler :
// la requête part bien au réseau. Seules les images `host=opera` et
// `path=/opera/AAAAMMJJTHHMM` sont relayées ; toute autre (ancienne image
// RainViewer d'un onglet resté ouvert) reçoit une 204.
// ---------------------------------------------------------------------------

const RADAR_OPERA_HOST = 'opera';
const RADAR_OPERA_PATH_RE = /^\/?opera\/\d{8}T\d{4}$/;
const RADAR_MAX_ZOOM = 22;

function isValidRadarTile(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > RADAR_MAX_ZOOM) return false;
  const n = 2 ** z;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n;
}

async function handleRadarTileRequest(url, z, x, y) {
  const host = (url.searchParams.get('host') || '').trim();
  const path = (url.searchParams.get('path') || '').trim();
  if (host !== RADAR_OPERA_HOST || !RADAR_OPERA_PATH_RE.test(path) || !isValidRadarTile(z, x, y)) {
    return new Response(null, { status: 204 });
  }
  try {
    const res = await fetch(url.href);
    if (res.ok && (res.headers.get('content-type') || '').toLowerCase().startsWith('image/')) return res;
  } catch {
    // Réseau coupé : pas de tuile (la carte garde les précédentes).
  }
  return new Response(null, { status: 204 });
}
