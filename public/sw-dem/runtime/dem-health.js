// ---------------------------------------------------------------------------
// Garde-fou de santé des tuiles DEM — rejette les tuiles qui ressemblent à du
// nodata ou anormalement décalées avant leur enregistrement dans le cache
// positif. En cas de rejet, tente une seule récupération par overzoom du
// parent. Voir l'en-tête de sw-dem.js pour le contexte.
//
// Extrait de sw-dem.js (3 mai).
// ---------------------------------------------------------------------------

const DEM_HEALTH_MIN_PARENT_RANGE_M = 40;
const DEM_HEALTH_MIN_COLLAPSED_RANGE_M = 4;
const DEM_HEALTH_MAX_MEAN_DELTA_M = 180;
const DEM_HEALTH_VERTICAL_OFFSET_M = 180;
const DEM_HEALTH_NODATA_MEAN_M = -8000;
// Les tuiles intérieures (France / Suisse / Norvège / Espagne) dont le raster
// d'altitude est pour l'essentiel le plan constant zéro (écart < 0,5 m ET
// |moyenne| < 1 m) sont des artefacts de corruption — typiquement un overzoom
// de parent d'une tuile Mapbox / AWS vide, ou un remplaçant décodé à zéro. Les
// vraies vallées plates à fort zoom sont toujours à ≥ 50 m (Loire ~50 m, Saône
// ~170 m, Rhône ~100 m, point le plus bas de Suisse 193 m, basses terres du
// sud-est de la Norvège bien au-dessus du niveau de la mer) : ce filtre ne peut
// donc pas rejeter de vraies données haute résolution. Sans lui, le rendu peint
// une dalle de terrain parfaitement plate au milieu d'un paysage en 3D (voir la
// capture du 3 mai 2026).
const DEM_HEALTH_FLAT_INLAND_RANGE_M = 0.5;
const DEM_HEALTH_FLAT_INLAND_MEAN_ABS_M = 1.0;

function isFlatlinedInlandStats(stats, z, x, y) {
  if (!stats?.valid) return false;
  if (!isExpertFallbackRiskTile(z, x, y)) return false;
  return stats.range < DEM_HEALTH_FLAT_INLAND_RANGE_M
    && Math.abs(stats.mean) < DEM_HEALTH_FLAT_INLAND_MEAN_ABS_M;
}

function summarizeDemElevations(elevations) {
  if (!elevations?.length) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < elevations.length; index += 1) {
    const value = elevations[index];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }

  if (count === 0) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  return {
    valid: true,
    min,
    max,
    mean: sum / count,
    range: max - min,
  };
}

async function guardDemTileHealth(cache, pngBlob, z, x, y, demSource, demProfile) {
  if (!pngBlob || z < 8) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  let currentElevations;
  try {
    currentElevations = await decodeTerrainRGBBlob(pngBlob);
  } catch (error) {
    console.warn(`[sw-dem][health] decode failed ${z}/${x}/${y} src=${demSource}`, error);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'decode-failed' };
  }

  const current = summarizeDemElevations(currentElevations);
  if (!current.valid) {
    console.warn(`[sw-dem][health] invalid stats ${z}/${x}/${y} src=${demSource}`);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'invalid-stats' };
  }

  if (current.max <= -9000 || current.mean <= DEM_HEALTH_NODATA_MEAN_M) {
    const recovered = await tryParentOverzoom(cache, z, x, y, 0, demProfile);
    if (recovered?.blob) {
      console.warn(
        `[sw-dem][health] rejecting nodata-like tile ${z}/${x}/${y} src=${demSource} mean=${current.mean.toFixed(1)} -> ${recovered.source}`,
      );
      return {
        blob: recovered.blob,
        demSource: `${recovered.source}-healthguard`,
        shortCache: true,
        healthStatus: 'recovered',
      };
    }
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'nodata-like' };
  }

  // Défense contre les intérieurs plats — voir le commentaire de
  // DEM_HEALTH_FLAT_INLAND_RANGE_M plus haut. Un raster d'écart ≈ 0 sur la France
  // ou la Suisse à z≥12 donnerait une dalle parfaitement plate. On le refuse :
  // on tente un overzoom du parent et on n'accepte la récupération que si elle
  // porte vraiment du relief.
  if (isFlatlinedInlandStats(current, z, x, y)) {
    const recovered = await tryParentOverzoom(cache, z, x, y, 0, demProfile);
    if (recovered?.blob) {
      let recoveredStats = { valid: false };
      try {
        const recoveredElev = await decodeTerrainRGBBlob(recovered.blob);
        recoveredStats = summarizeDemElevations(recoveredElev);
      } catch { /* on continue et on rejette */ }
      if (recoveredStats.valid && !isFlatlinedInlandStats(recoveredStats, z, x, y)) {
        console.warn(
          `[sw-dem][health] rejecting flat-inland tile ${z}/${x}/${y} src=${demSource} mean=${current.mean.toFixed(2)} range=${current.range.toFixed(2)} -> ${recovered.source}`,
        );
        return {
          blob: recovered.blob,
          demSource: `${recovered.source}-flatguard`,
          shortCache: true,
          healthStatus: 'recovered',
        };
      }
    }
    console.warn(
      `[sw-dem][health] rejecting flat-inland tile ${z}/${x}/${y} src=${demSource} mean=${current.mean.toFixed(2)} range=${current.range.toFixed(2)} (no recovery)`,
    );
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'flat-inland' };
  }

  // Contrôle de cohérence avec l'ancêtre — seulement contre un parent DÉJÀ
  // disponible. Avant, tryParentOverzoom() tournait pour chaque tuile saine : un
  // overzoom bicubique + encodage + décodage PNG (~40 à 60 ms de CPU du SW par
  // tuile) et, quand aucun parent n'était en cache, une CONSTRUCTION récursive
  // complète du parent (fetch WMS, en contournant DEM_INFLIGHT) sérialisée avant
  // de pouvoir servir l'enfant. Les statistiques du sous-rectangle du parent
  // répondent à la même question en ~1 ms ; l'overzoom coûteux ne tourne plus
  // que pour la rare tuile anormale ci-dessous.
  const parentInfo = await findCachedParentStats(cache, z, x, y, demProfile);
  if (!parentInfo) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }
  const parent = parentInfo.stats;

  const meanDelta = Math.abs(current.mean - parent.mean);
  const collapsedRangeThreshold = Math.max(DEM_HEALTH_MIN_COLLAPSED_RANGE_M, parent.range * 0.15);
  const collapsedRelief = parent.range >= DEM_HEALTH_MIN_PARENT_RANGE_M && current.range <= collapsedRangeThreshold;
  const verticalDrop = current.max < parent.min - DEM_HEALTH_VERTICAL_OFFSET_M;
  const verticalRise = current.min > parent.max + DEM_HEALTH_VERTICAL_OFFSET_M;
  const hugeOffset = meanDelta >= DEM_HEALTH_MAX_MEAN_DELTA_M;

  if (verticalDrop || verticalRise || (collapsedRelief && hugeOffset)) {
    const parentFallback = await tryParentOverzoom(cache, z, x, y, 0, demProfile);
    // Même résultat qu'avant quand aucun blob de récupération ne peut être produit : on garde la tuile.
    if (!parentFallback?.blob) {
      return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
    }
    console.warn(
      `[sw-dem][health] rejecting anomalous tile ${z}/${x}/${y} src=${demSource} current=[${current.min.toFixed(1)}..${current.max.toFixed(1)}] parent=[${parent.min.toFixed(1)}..${parent.max.toFixed(1)}] meanDelta=${meanDelta.toFixed(1)} -> ${parentFallback.source}`,
    );
    return {
      blob: parentFallback.blob,
      demSource: `${parentFallback.source}-healthguard`,
      shortCache: true,
      healthStatus: 'recovered',
    };
  }

  return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
}
