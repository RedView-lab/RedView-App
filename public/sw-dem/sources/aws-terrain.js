// ---------------------------------------------------------------------------
// AWS Open Data — récupération des tuiles DEM Terrarium (remplace fetchMapboxTile)
//
// Point d'accès : https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// Pourquoi : l'ancien repli raster-DEM commercial était facturé sur le SKU
// Raster Tiles API. Le jeu de données AWS Open Data Terrain Tiles (ex-Mapzen,
// hébergé gratuitement par AWS) couvre tout le globe à ~30 m de résolution,
// gratuit et sans limite. Il remplace Mapbox partout où le SW appelait Mapbox
// pour le DEM mondial, ce qui réduit fortement la facture Raster Tiles sans
// régression visible aux zooms concernés (z ≤ 14 dans le monde, z ≤ ~11 sur la
// France et la Suisse, où IGN / swissALTI prennent le relais en haute résolution).
//
// Conversion d'encodage :
//   Terrarium  : altitude = (R*256 + G + B/256) − 32768
//   Terrain-RGB: altitude = -10000 + (R*65536 + G*256 + B) * 0.1
// On décode le Terrarium → Float32 → on réencode en Terrain-RGB, pour que le
// reste du pipeline du SW (composition, pente, altitude, overzoom) ne change pas.
// ---------------------------------------------------------------------------

// Zoom maximal natif des tuiles AWS Terrarium. Au-delà, les requêtes renvoient 404.
// Identique à Mapbox terrain-DEM v1 (z14 natif) : la logique de plafonnement
// existante chez les appelants fonctionne sans changement.
const AWS_TERRAIN_MAXZOOM = 14;

// Point d'accès public, sans authentification. Pas de souci CORS — le bucket
// est configuré avec Access-Control-Allow-Origin: *.
const AWS_TERRAIN_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// Limiteur de concurrence réseau — évite l'épuisement des sockets quand 400+ tuiles arrivent en rafale
const AWS_FETCH_MAX_CONCURRENT = 32;
let _awsFetchActive = 0;
const _awsFetchQueue = [];

function acquireAwsFetchSlot() {
  if (_awsFetchActive < AWS_FETCH_MAX_CONCURRENT) {
    _awsFetchActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _awsFetchQueue.push(resolve));
}

function releaseAwsFetchSlot() {
  _awsFetchActive = Math.max(0, _awsFetchActive - 1);
  if (_awsFetchQueue.length > 0 && _awsFetchActive < AWS_FETCH_MAX_CONCURRENT) {
    _awsFetchActive++;
    _awsFetchQueue.shift()();
  }
}

// `outcome` (facultatif) dit pourquoi la tuile manque quand la fonction rend
// null : `missing` n'est vrai que sur un 404 / 410, la seule absence que S3
// confirme. Toute autre erreur (5xx, 429, 403, délai de 6 s, coupure réseau,
// décodage) est passagère : l'appelant ne doit pas la garder comme un trou
// (cache négatif d'une heure, B5-1 de l'audit du 2026-10-10).
async function fetchAWSTerrainTile(z, x, y, outcome) {
  // Plafonné au zoom natif — au-delà de z14, AWS renvoie 404. Le GPU de
  // Mapbox GL suréchantillonne à partir de la tuile parente.
  const fetchZ = Math.min(z, AWS_TERRAIN_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;
  const clamped = fetchZ < z;

  const url = `${AWS_TERRAIN_BASE}/${fetchZ}/${fetchX}/${fetchY}.png`;
  await acquireAwsFetchSlot();
  // Le créneau doit être libéré exactement une fois sur chaque chemin : un
  // oubli sur les erreurs HTTP faisait fuir les créneaux jusqu'à épuisement des
  // 32, et tous les fetchs AWS (DEM mondial + pente à 30 m) attendaient sans fin.
  let slotHeld = true;
  const releaseSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    releaseAwsFetchSlot();
  };
  try {
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), priority: 'high' });
    const dt = (performance.now() - t0).toFixed(0);

    if (!res.ok) {
      releaseSlot();
      if (outcome && (res.status === 404 || res.status === 410)) outcome.missing = true;
      if (DEBUG) {
        console.warn(
          `[sw-dem][aws] %c FAIL %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ}/${fetchX}/${fetchY})` : ''} — HTTP ${res.status}, ${dt}ms`,
          'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
        );
      }
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    releaseSlot();

    // ── Chemin rapide par le pool de workers multicœur (2026-08-29) ────────
    // Délègue le décodage, la conversion Terrarium → Terrain-RGB et
    // l'encodage PNG filtré en Sub au pool de workers, sur tous les cœurs.
    if (typeof computeAwsTerrariumViaPool === 'function') {
      try {
        const poolBlob = await computeAwsTerrariumViaPool(
          arrayBuffer.slice(0), z, x, y, fetchZ, fetchX, fetchY, clamped,
        );
        if (poolBlob) return poolBlob;
      } catch { /* on poursuit dans le processus courant */ }
    }

    // ── Repli dans le processus ──────────────────────────────────────────
    const blob = new Blob([arrayBuffer], { type: 'image/png' });
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

    let elevations;
    try {
      const width = img.width;
      const height = img.height;
      const ctx = typeof getSharedOffscreenCtx === 'function'
        ? getSharedOffscreenCtx(width, height)
        : new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;

      const srcSize = width;
      if (srcSize === DEM_TILE_SIZE && height === DEM_TILE_SIZE) {
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        for (let i = 0; i < elevations.length; i++) {
          const idx = i * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          elevations[i] = (r * 256 + g + b / 256) - 32768;
        }
      } else {
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        const scale = srcSize / DEM_TILE_SIZE;
        for (let py = 0; py < DEM_TILE_SIZE; py++) {
          const sy = Math.min((py * scale) | 0, srcSize - 1);
          for (let px = 0; px < DEM_TILE_SIZE; px++) {
            const sx = Math.min((px * scale) | 0, srcSize - 1);
            const idx = (sy * srcSize + sx) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            elevations[py * DEM_TILE_SIZE + px] = (r * 256 + g + b / 256) - 32768;
          }
        }
      }
    } finally {
      img.close();
    }

    if (clamped && typeof overzoomDemElevations === 'function') {
      const upsampled = overzoomDemElevations(elevations, fetchZ, fetchX, fetchY, z, x, y);
      return encodeTerrainRGBPng(upsampled || elevations);
    }
    return encodeTerrainRGBPng(elevations);
  } catch (err) {
    releaseSlot();
    if (DEBUG) {
      console.warn(
        `[sw-dem][aws] %c ERROR %c ${z}/${x}/${y} — ${err.message || err}`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
      );
    }
    return null;
  }
}
