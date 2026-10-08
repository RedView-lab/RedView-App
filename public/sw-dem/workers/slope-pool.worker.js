// ---------------------------------------------------------------------------
// WORKER de construction des pentes — une instance par cœur logique (gérée par
// le SW via runtime/slope-pool.js). Reçoit des BLOBS DEM BRUTS (propre + jusqu'à
// 4 voisines cardinales), les décode, exécute le pipeline Horn + encodage en
// gamma racine HORS du fil du SW, et renvoie un ArrayBuffer PNG transférable.
//
// Pourquoi un Worker dédié (et pas un SharedWorker / SharedArrayBuffer) :
//   * Les Workers dédiés peuvent être créés DEPUIS un Service Worker.
//   * Pas besoin d'en-têtes COOP/COEP — on utilise des ArrayBuffer transférables
//     (sans copie) au lieu d'un SAB, donc le jeu d'en-têtes de vercel.json reste tel quel.
//   * Chaque worker a son propre tas JS et son JIT — V8 peut optimiser en SIMD
//     la boucle interne de Horn indépendamment de l'unité de compilation du SW.
//
// Protocole de messages :
//   entrée : { id, z, x, y, resFactor, outputScale, zoneRing,
//              ownDem: ArrayBuffer,            // octets PNG Terrain-RGB bruts
//              neighbours: {
//                north?: ArrayBuffer,
//                east?:  ArrayBuffer,
//                south?: ArrayBuffer,
//                west?:  ArrayBuffer } }
//   sortie : { id, ok: true, png: ArrayBuffer, missingDirections: string[] }
//            | { id, ok: false, error: string }
//
// Tous les tampons DEM sont TRANSFÉRÉS (sans copie) — le SW en perd la propriété
// à l'envoi. Le worker les décode par decodeTerrainRGBBlob (le même chemin que
// celui du SW), donc la lourde boucle createImageBitmap + getImageData + Float32
// tourne HORS du fil du SW. C'était le plus gros goulot restant : sur une vue de
// 90 tuiles, le SW faisait ~450 décodages (90 propres + 4 voisines chacune) de
// 8 à 20 ms = 3 à 9 s de CPU qui bloquaient le pipeline du fond de carte. En le
// déplaçant dans les workers, le SW ne paie plus que la lecture CacheStorage
// (5 à 25 ms) par tuile et le transfert.
//
// Chaque worker garde un petit LRU d'altitudes décodées indexé par coordonnées
// de tuile, pour qu'un blob voisin décodé par le worker N pour la tuile A soit
// réutilisé quand la tuile B (adjacente) envoie le même blob.
// ---------------------------------------------------------------------------

// Même convention d'invalidation par époque que le SW, pour qu'une purge de
// cache au changement d'époque vide aussi le cache des sous-modules du worker.
// L'époque arrive en paramètre de l'URL du worker lui-même (posé par
// slope-pool.js > slopePoolWorkerURL).
const _workerEpoch =
  new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base';
const _withEpoch = (p) => `${p}?rv-map-cache-epoch=${encodeURIComponent(_workerEpoch)}`;

importScripts(
  _withEpoch('../../sw-dem/core/config.js'),
  _withEpoch('../../sw-dem/core/geo.js'),
  _withEpoch('../../sw-dem/core/interpolation.js'),
  _withEpoch('../../sw-dem/core/terrain-rgb.js'),
  _withEpoch('../../sw-dem/processing/altitude.js'),
  _withEpoch('../../sw-dem/workers/slope-math.js'),
);

// ── LRU local au worker des DEM décodés ───────────────────────────────
// Un worker traite les tuiles du SW à tour de rôle : les tuiles adjacentes (qui
// partagent des DEM voisins) tombent souvent sur des workers DIFFÉRENTS. Un LRU
// par worker a donc un taux de succès entre tuiles limité, MAIS il attrape
// quand même le cas courant où le MÊME blob est décodé deux fois dans la file
// d'un worker (p. ex. quand le SW renvoie une voisine évincée du LRU côté SW mais
// encore en cours ici). Petit budget — les workers ont moins de mémoire que le SW.
const WORKER_DEM_LRU_MAX = 128;
const _workerDemLru = new Map(); // clé "z/x/y" → Float32Array

function workerDemGet(key) {
  if (!_workerDemLru.has(key)) return null;
  const v = _workerDemLru.get(key);
  _workerDemLru.delete(key);
  _workerDemLru.set(key, v);
  return v;
}
function workerDemPut(key, elev) {
  if (!elev) return elev;
  if (_workerDemLru.has(key)) _workerDemLru.delete(key);
  _workerDemLru.set(key, elev);
  while (_workerDemLru.size > WORKER_DEM_LRU_MAX) {
    const k = _workerDemLru.keys().next().value;
    if (k === undefined) break;
    _workerDemLru.delete(k);
  }
  return elev;
}

// FNV-1a sur les octets du PNG. Le LRU était indexé par « z/x/y » seul : une
// tuile décodée une fois depuis un DEM de remplacement (parent de secours AWS,
// overzoom, profil terrain à 30 m ou à 1 m, construction d'avant mise à niveau)
// continuait d'être servie pour la vraie tuile LiDAR des mêmes coordonnées :
// tuiles de pente lisses ou incohérentes et jointures qui ne se réparaient
// jamais. Indexer par contenu fait d'un nouveau DEM une nouvelle entrée ;
// ~0,2 ms pour une tuile de 150 Ko.
function demContentHash(buf) {
  const bytes = new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function workerDecodeDem(buf, z, x, y) {
  const key = `${z}/${x}/${y}:${buf.byteLength}:${demContentHash(buf)}`;
  const cached = workerDemGet(key);
  if (cached) return cached;
  // Enveloppe l'ArrayBuffer transféré dans un Blob pour decodeTerrainRGBBlob.
  // (decodeTerrainRGBBlob est mémoïsé par identité de Blob via une WeakMap, mais
  // on garde aussi notre propre LRU indexé par coordonnées pour la réutilisation
  // entre tâches.)
  const blob = new Blob([buf], { type: 'image/png' });
  const elev = await decodeTerrainRGBBlob(blob);
  return workerDemPut(key, elev);
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;

  // ── Branche de construction d'altitude (altitude-decode-in-worker du 2026-06-29) ──
  // L'altitude n'a besoin que de son PROPRE DEM décodé (pas de voisines pour les
  // jointures comme la pente), puis de l'encodage RGBA d'altitude et de
  // l'enveloppe PNG. Réutilise le même worker et le même LRU de DEM par worker
  // que la pente : quand les deux overlays sont actifs sur la même tuile, le
  // second trouve les altitudes déjà décodées (succès entre overlays). Renvoie un
  // ArrayBuffer PNG TRANSFÉRABLE — retour au SW sans copie.
  if (msg.kind === 'altitude') {
    try {
      if (!msg.ownDem || !msg.ownDem.byteLength) {
        self.postMessage({ id, ok: false, error: 'missing-own-dem' });
        return;
      }
      const elevations = await workerDecodeDem(msg.ownDem, msg.z, msg.x, msg.y);
      if (!elevations) {
        self.postMessage({ id, ok: false, error: 'own-dem-decode-failed' });
        return;
      }

      const size = DEM_TILE_SIZE;
      const rgba = buildAltitudeRgba(elevations);
      // Masque de zone d'analyse — rasterizeRingMask / applyRingMaskToRgba
      // viennent de slope-math.js (importScripts plus haut), ce qui garde
      // identiques à l'octet près les sorties du pool et du processus courant.
      if (msg.zoneRing) {
        const zoneMask = rasterizeRingMask(msg.zoneRing, msg.z, msg.x, msg.y, size);
        if (zoneMask) applyRingMaskToRgba(rgba, zoneMask);
      }
      const pngBlob = (typeof buildRawPngSlope === 'function')
        ? await buildRawPngSlope(size, size, rgba)
        : await buildRawPng(size, size, rgba);
      const pngBuf = await pngBlob.arrayBuffer();

      // Renvoie le tampon PNG — sans copie.
      self.postMessage({ id, ok: true, png: pngBuf }, [pngBuf]);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  // ── Branche multicœur AWS Terrarium → Terrain-RGB (2026-08-29) ────────
  // Décode le PNG Terrarium brut, le convertit en RGBA Terrain-RGB dans une
  // boucle serrée sur tableaux typés, et encode le PNG avec le filtre Sub rapide,
  // hors du fil principal du SW.
  if (msg.kind === 'aws-terrarium') {
    try {
      if (!msg.terrariumBuf || !msg.terrariumBuf.byteLength) {
        self.postMessage({ id, ok: false, error: 'missing-terrarium-buf' });
        return;
      }
      const blob = new Blob([msg.terrariumBuf], { type: 'image/png' });
      const img = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const width = img.width;
      const height = img.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      img.close();
      const imgData = ctx.getImageData(0, 0, width, height);
      const srcPixels = imgData.data;
      const len = width * height;

      let outRgba;
      if (msg.clamped && typeof overzoomDemElevations === 'function') {
        const elevations = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          elevations[i] = (srcPixels[idx] * 256 + srcPixels[idx + 1] + srcPixels[idx + 2] / 256) - 32768;
        }
        const upsampled = overzoomDemElevations(elevations, msg.fetchZ, msg.fetchX, msg.fetchY, msg.z, msg.x, msg.y);
        const targetElev = upsampled || elevations;
        outRgba = new Uint8Array(DEM_TILE_SIZE * DEM_TILE_SIZE * 4);
        for (let i = 0; i < targetElev.length; i++) {
          const height = sanitizeElevation(targetElev[i]);
          const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) * 10)));
          const idx = i * 4;
          outRgba[idx]     = (val >> 16) & 0xff;
          outRgba[idx + 1] = (val >>  8) & 0xff;
          outRgba[idx + 2] =  val        & 0xff;
          outRgba[idx + 3] = 255;
        }
      } else {
        outRgba = new Uint8Array(len * 4);
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          const r = srcPixels[idx];
          const g = srcPixels[idx + 1];
          const b = srcPixels[idx + 2];
          // Terrarium : H = R*256 + G + B/256 - 32768
          // Terrain-RGB : val = (H + 10000) * 10 = (R*256 + G + B*0.00390625 - 22768) * 10
          const raw = (r * 256 + g + b * 0.00390625 - 22768) * 10;
          const val = raw > 0 ? (raw > 16777215 ? 16777215 : (raw + 0.5) | 0) : 0;
          outRgba[idx]     = (val >> 16) & 0xff;
          outRgba[idx + 1] = (val >>  8) & 0xff;
          outRgba[idx + 2] =  val        & 0xff;
          outRgba[idx + 3] = 255;
        }
      }

      const pngBlob = (typeof buildRawPngSlope === 'function')
        ? await buildRawPngSlope(width, height, outRgba)
        : await buildRawPng(width, height, outRgba);
      const pngBuf = await pngBlob.arrayBuffer();

      self.postMessage({ id, ok: true, png: pngBuf }, [pngBuf]);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  try {
    // Décode le blob DEM propre dans le worker.
    if (!msg.ownDem || !msg.ownDem.byteLength) {
      self.postMessage({ id, ok: false, error: 'missing-own-dem' });
      return;
    }
    const ownElev = await workerDecodeDem(msg.ownDem, msg.z, msg.x, msg.y);
    if (!ownElev) {
      self.postMessage({ id, ok: false, error: 'own-dem-decode-failed' });
      return;
    }

    // Décode chaque blob DEM voisin dans le worker (quand il existe).
    const neighbours = {};
    const missingDirections = [];
    if (msg.neighbours) {
      const dirs = [
        ['north', msg.z, msg.x, msg.y - 1],
        ['east',  msg.z, msg.x + 1, msg.y],
        ['south', msg.z, msg.x, msg.y + 1],
        ['west',  msg.z, msg.x - 1, msg.y],
      ];
      // Décodage en parallèle — ils sont indépendants et chacun fait son propre
      // createImageBitmap, lui-même asynchrone et lié aux E/S.
      await Promise.all(dirs.map(async ([dir, nz, nx, ny]) => {
        const buf = msg.neighbours[dir];
        if (!buf || !buf.byteLength) { missingDirections.push(dir); return; }
        try {
          const elev = await workerDecodeDem(buf, nz, nx, ny);
          if (elev) neighbours[dir] = elev;
          else missingDirections.push(dir);
        } catch {
          missingDirections.push(dir);
        }
      }));
    }

    const result = await buildSlopePngFromElevations(ownElev, neighbours, msg.z, msg.x, msg.y, {
      resFactor: msg.resFactor,
      outputScale: msg.outputScale,
      zoneRing: msg.zoneRing || null,
    });

    // Fusionne dans le résultat les directions manquantes détectées côté worker.
    for (const d of missingDirections) {
      if (!result.missingDirections.includes(d)) result.missingDirections.push(d);
    }

    // Renvoie le tampon PNG — sans copie.
    const pngArrayBuffer = await result.blob.arrayBuffer();
    self.postMessage(
      { id, ok: true, png: pngArrayBuffer, missingDirections: result.missingDirections },
      [pngArrayBuffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

