// ---------------------------------------------------------------------------
// Handler des tuiles d'altitude — /altitude-tiles/{z}/{x}/{y}[?rv-dem-profile=terrain][&zone=<hash>]
//
// Atteint seulement en qualité 3D HD (fast-30m envoie AWS Terrarium directement
// au GPU sans passer par le SW — voir features/altitude/lib/altitude-source.ts).
//
// Sans zone (le cas courant) : un ALIAS EN LECTURE du pipeline DEM. Le blob DEM
// Terrain-RGB est servi tel quel — Mapbox le décode sur le GPU par
// raster-color-mix —, donc ni décodage ni encodage, et ni CacheStorage ni
// niveau chaud propres à l'altitude (ils ne faisaient que dupliquer les octets
// du DEM). Cache chaud DEM → CacheStorage → fusion DEM_INFLIGHT répondent à
// presque toutes les requêtes, car la page plafonne la source à
// ALTITUDE_MAX_BUILD_ZOOM, c'est-à-dire les zooms que le terrain 3D charge
// lui-même. Un vrai échec de cache à ces zooms rejoint la construction du
// terrain (même clé DEM_INFLIGHT) ; au-dessus du plafond, on ne construit jamais.
//
// Avec zone : masque du polygone via le pool de workers / le constructeur du
// processus courant, mis en cache sous la clé `?zone=`.
//
// Pas encore de tuile DEM définitive (LiDAR encore en attente sous charge,
// construction annulée, échec passager, remplaçant brièvement en cache) : Mapbox
// garde toute image en 200 comme définitive, et la tuile transparente servie
// ici restait pour de bon comme un trou dans l'overlay. La tuile est désormais
// provisoire — le DEM ancêtre en cache le plus proche, suréchantillonné (ce que
// le terrain y rend aussi), jamais mis en cache — et la page recharge la source
// d'altitude sur ALTITUDE_TILES_STALE dès que la vraie tuile DEM arrive
// (derived-tile-stale.js).
// ---------------------------------------------------------------------------

const ALTITUDE_MAX_BUILD_ZOOM = 14;

const ALTITUDE_STALE_TRACKER = createDerivedTileStaleTracker('ALTITUDE_TILES_STALE');

// Tuiles DEM de remplacement : brièvement en cache (overzoom du parent, sol nu,
// secours AWS) ou suréchantillonnées depuis un ancêtre.
function isProvisionalDemResponse(response) {
  if (response.headers.get('x-cache-ttl-ms')) return true;
  return (response.headers.get('X-DEM-Source') || '').toLowerCase().startsWith('overzoom');
}

// Nouvelle tentative à l'aveugle plafonnée (une 204 peut être passagère) +
// rechargement dès que la vraie tuile DEM est enregistrée.
function noteAltitudeTileProvisional(tileKey, demProfile, z, x, y) {
  ALTITUDE_STALE_TRACKER.noteStale(tileKey);
  ALTITUDE_STALE_TRACKER.waitOnDem(tileKey, demProfile, z, [[x, y]]);
}

// Le DEM ancêtre le plus proche déjà dans le niveau chaud / CacheStorage,
// suréchantillonné à cette tuile. Ne construit jamais rien.
async function altitudeAncestorResponse(demCache, z, x, y, demProfile) {
  if (typeof tryParentOverzoom !== 'function') return null;
  const parent = await tryParentOverzoom(demCache, z, x, y, 0, demProfile, { cachedOnly: true });
  if (!parent?.blob) return null;
  return new Response(parent.blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-DEM-Source': parent.source,
      'X-Tile-Type': 'altitude-provisional',
    },
  });
}

function isAltitudeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== altitudeCancelGeneration;
}

async function handleAltitudeRequest(z, x, y, zoneHash = '', demProfile = 'default') {
  if (!zoneHash) return handleAltitudePassthrough(z, x, y, demProfile);

  // ── Clé de cache de la zone d'analyse ─────────────────────────────────
  // `?zone=<hash>` sépare les tuiles masquées des non masquées dans CacheStorage
  // et le niveau chaud (même convention que le handler des pentes), pour qu'une
  // modification de zone ne puisse jamais servir une tuile non masquée périmée
  // sous la nouvelle clé.
  const hotKey = `/altitude-tiles/${z}/${x}/${y}${zoneHash ? `?zone=${zoneHash}` : ''}`;
  const hot = (typeof altitudeHotGet === 'function') ? altitudeHotGet(hotKey) : null;
  if (hot) return altitudeHotResponse(hot);

  const altitudeCache = await caches.open(ALTITUDE_CACHE_NAME);
  const cacheKey = new Request(hotKey);
  const cached = await altitudeCache.match(cacheKey);
  if (cached) {
    // Promeut un succès frais de CacheStorage dans le niveau chaud, pour que la
    // requête suivante saute entièrement CacheStorage. Peu coûteux (le Blob est
    // compté par références).
    try {
      if (typeof altitudeHotPut === 'function') {
        altitudeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      }
    } catch { /* ignore */ }
    return cached;
  }

  // ── Analysis-zone early rejection ────────────────────────────────────
  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash) {
    if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
      return transparentTileResponse();
    }
  }

  const inflightKey = `${z}/${x}/${y}${zoneHash ? `?z=${zoneHash}` : ''}`;
  const existing = ALTITUDE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* on continue et on recalcule */ }
  }

  const generation = null; // les constructions de zone ne sont pas annulables (comme avant)
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);

    // 1. Récupère la tuile DEM existante dans le cache du terrain 3D / les requêtes en cours (JAMAIS de téléchargement de DEM pour l'altitude)
    const demResponse = (typeof getExistingTerrainDemResponse === 'function')
      ? await getExistingTerrainDemResponse(z, x, y, demProfile, demCache)
      : null;

    if (isAltitudeWorkCancelled(generation) || !demResponse || demResponse.status !== 200) {
      noteAltitudeTileProvisional(hotKey, demProfile, z, x, y);
      return transparentTileResponse();
    }
    const provisional = isProvisionalDemResponse(demResponse);
    if (provisional) noteAltitudeTileProvisional(hotKey, demProfile, z, x, y);
    else ALTITUDE_STALE_TRACKER.noteFinal(hotKey);

    try {
      const demBlob = await demResponse.clone().blob();
      if (isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      let altitudeBlob = null;
      if (!zoneRing) {
        altitudeBlob = demBlob;
      } else {
        // ── Zone-masked build path: worker pool first, in-process fallback ──
        let usedPool = false;
        if (typeof computeAltitudeViaPool === 'function') {
          try {
            const poolResult = await computeAltitudeViaPool(demBlob, z, x, y, generation, zoneRing);
            if (poolResult) {
              altitudeBlob = poolResult.blob;
              usedPool = true;
            }
          } catch {
            /* on poursuit dans le processus courant */
          }
        }

        if (!usedPool) {
          altitudeBlob = await scheduleAltitudeBuild(
            () => buildAltitudeTile(
              demBlob,
              z,
              x,
              y,
              () => isAltitudeWorkCancelled(generation),
              zoneRing,
            ),
            generation,
          );
        }
      }

      if (!altitudeBlob || isAltitudeWorkCancelled(generation)) {
        return transparentTileResponse();
      }
      const response = new Response(altitudeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': provisional ? 'no-store' : 'public, max-age=604800',
          'X-Tile-Type': 'altitude',
        },
      });
      // Une tuile masquée sur un DEM de remplacement est reconstruite quand le vrai arrive.
      if (!provisional && !isAltitudeWorkCancelled(generation)) {
        altitudeCache.put(cacheKey, response.clone());
        // Promeut la tuile fraîchement construite dans le niveau chaud
        // d'altitude, pour qu'une nouvelle demande immédiate (repeinte de
        // Mapbox, désactivation puis réactivation peu après) réponde en < 1 ms.
        try {
          if (typeof altitudeHotPut === 'function') {
            altitudeHotPut(hotKey, altitudeBlob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
      }
      return response;
    } catch (err) {
      console.error('[altitude]', z, x, y, err);
      return transparentTileResponse();
    }
  })();

  ALTITUDE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    if (ALTITUDE_INFLIGHT.get(inflightKey) === work) {
      ALTITUDE_INFLIGHT.delete(inflightKey);
    }
  }
}

// Non annulable : la lecture du DEM est la tuile du terrain lui-même (même
// pyramide, voir altitude-source.ts), et une requête annulée répondait une tuile
// transparente que Mapbox gardait comme définitive — des trous dans l'overlay
// après un déplacement.
async function handleAltitudePassthrough(z, x, y, demProfile) {
  const tileKey = `/altitude-tiles/${demProfile}/${z}/${x}/${y}`;
  try {
    const demCache = await caches.open(CACHE_NAME);
    const demResponse = (typeof getExistingTerrainDemResponse === 'function')
      ? await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, '', {
          allowBuild: z <= ALTITUDE_MAX_BUILD_ZOOM,
        })
      : null;
    if (demResponse && demResponse.status === 200) {
      if (isProvisionalDemResponse(demResponse)) {
        noteAltitudeTileProvisional(tileKey, demProfile, z, x, y);
      } else {
        ALTITUDE_STALE_TRACKER.noteFinal(tileKey);
      }
      const headers = new Headers(demResponse.headers);
      headers.set('X-Tile-Type', 'altitude');
      return new Response(demResponse.body, { status: 200, headers });
    }
    // Pas de tuile DEM pour l'instant : le terrain rend ici le maillage de son
    // parent, l'overlay aussi jusqu'à l'arrivée de la tuile.
    noteAltitudeTileProvisional(tileKey, demProfile, z, x, y);
    const ancestor = await altitudeAncestorResponse(demCache, z, x, y, demProfile);
    if (ancestor) return ancestor;
  } catch (err) {
    console.error('[altitude]', z, x, y, err);
  }
  return transparentTileResponse();
}
