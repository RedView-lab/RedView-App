// ---------------------------------------------------------------------------
// Construction d'une tuile DEM Mercator à partir de swissSURFACE3D Raster (COG)
// ---------------------------------------------------------------------------
// Calquée sur buildIGNTile() pour que handleDemRequest puisse aiguiller France
// ou Suisse avec le même contrat en aval :
//   { blob, elevations, coverage, source, allPermanentMissing, pendingFetches }
//
// Stratégie :
//   1. Trouver les cellules kilométriques LV95 qui recoupent la tuile Mercator
//      (quelques cellules).
//   2. Pour chaque cellule, résoudre son item STAC → URL du COG (en cache).
//   3. Pour chaque pixel de sortie, projeter en LV95 → échantillonner le COG
//      (bilinéaire).
//   4. Despike + renvoi (composite.js gère l'alignement de jointure MNS↔MNT
//      contre le Terrain-RGB Mapbox comme pour l'IGN).
//
// Toutes les lectures d'en-têtes COG et les fetchs de plages de tuiles sont en
// cache : la deuxième tuile Mercator de la même zone réutilise tout.
// ---------------------------------------------------------------------------

// Cache négatif par zone — quand chaque cellule kilométrique d'une tuile
// Mercator correspond à « aucun COG publié », toutes les tuiles voisines de la
// même zone donneront le même résultat. On saute le travail par pixel.
const swissAreaNegCache = new Map();
const SWISS_AREA_NEG_TTL = 30 * 60_000; // 30 min

function swissAreaNegKey(z, x, y) {
  return `${z}/${x >> 1}/${y >> 1}`; // group 2×2 sibling tiles
}
function swissAreaNegGet(z, x, y) {
  const e = swissAreaNegCache.get(swissAreaNegKey(z, x, y));
  if (!e) return false;
  if (Date.now() - e.ts < SWISS_AREA_NEG_TTL) return true;
  swissAreaNegCache.delete(swissAreaNegKey(z, x, y));
  return false;
}
function swissAreaNegSet(z, x, y) {
  swissAreaNegCache.set(swissAreaNegKey(z, x, y), { ts: Date.now() });
  if (swissAreaNegCache.size > 500) {
    const iter = swissAreaNegCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = iter.next().value;
      if (k !== undefined) swissAreaNegCache.delete(k);
    }
  }
}

async function buildSwissTile(mercZ, mercX, mercY) {
  const t0 = performance.now();

  if (swissAreaNegGet(mercZ, mercX, mercY)) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-empty-cached',
      allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Étape 1 — trouver les COG qui couvrent cette tuile
  const cells = mercTileToLV95KmCells(mercZ, mercX, mercY);
  if (!cells) {
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-outside', allPermanentMissing: true, pendingFetches: null,
    };
  }

  // Résout en parallèle toutes les cellules qui se recoupent — une requête STAC
  // couvre de nombreuses cellules grâce à la recherche par bbox fenêtrée de
  // getCOGUrlForCell(). En pipeline : le fetch de l'en-tête COG part dès qu'une
  // URL est résolue, au lieu d'attendre la requête STAC la plus lente avant
  // toute demande d'en-tête. Économise ~1 aller-retour par tuile Mercator à froid.
  const cellEntries = []; // { Ekm, Nkm, url, cog, stacTransient }
  const cellReady = []; // promesses résolues une fois {url, cog?} renseignés
  for (let Ekm = cells.EkmMin; Ekm <= cells.EkmMax; Ekm++) {
    for (let Nkm = cells.NkmMin; Nkm <= cells.NkmMax; Nkm++) {
      const entry = { Ekm, Nkm, url: null, cog: null, stacTransient: false };
      cellEntries.push(entry);
      cellReady.push(
        getCOGUrlForCell(Ekm, Nkm).then(async (url) => {
          if (url === SWISS_STAC_TRANSIENT) {
            entry.stacTransient = true;
            return;
          }
          entry.url = url;
          if (url) {
            entry.cog = await openSwissCOG(url);
          }
        }),
      );
    }
  }
  await Promise.all(cellReady);
  const stacHadTransientFailure = cellEntries.some((c) => c.stacTransient);

  const resolvedUrlCount = cellEntries.filter((c) => c.url).length;
  const usableCells = cellEntries.filter((c) => c.cog);
  if (typeof swLog !== 'undefined' && swLog.isDebug()) {
    swLog.debug(
      'swiss',
      `%c ${mercZ}/${mercX}/${mercY} %c cells queried=${cellEntries.length} resolved-url=${resolvedUrlCount} cog-open=${usableCells.length} stac-transient=${stacHadTransientFailure} (E:${cells.EkmMin}-${cells.EkmMax} N:${cells.NkmMin}-${cells.NkmMax})`,
      'background:#D52B1E;color:#fff;padding:1px 4px;border-radius:2px', '',
    );
  }
  if (usableCells.length === 0) {
    // Essentiel : ne marquer la zone en négatif que si STAC a RÉUSSI sans
    // donnée (le catalogue dit vraiment qu'aucun COG n'est publié ici). Quand
    // STAC a échoué passagèrement, on noircirait sinon un bloc Mercator de 2×2
    // pendant 30 min à cause d'un seul délai dépassé → tuiles plates visibles à
    // côté de voisines LiDAR suisses en relief.
    if (resolvedUrlCount === 0 && !stacHadTransientFailure) {
      swissAreaNegSet(mercZ, mercX, mercY);
      if (typeof swLog !== 'undefined' && swLog.isDebug()) {
        swLog.debug('swiss', `${mercZ}/${mercX}/${mercY} \u2192 STAC OK with 0 cells, marking area-neg`);
      }
      return {
        blob: null, elevations: null, coverage: null,
        source: 'swiss-empty', allPermanentMissing: true, pendingFetches: null,
      };
    }
    if (typeof swLog !== 'undefined' && swLog.isDebug()) {
      if (stacHadTransientFailure) {
        swLog.debug('swiss', `${mercZ}/${mercX}/${mercY} \u2192 STAC transient failure, keeping area live for retry`);
      } else {
        swLog.debug('swiss', `${mercZ}/${mercX}/${mercY} \u2192 COG headers unavailable, keeping area live for retry`);
      }
    }
    return {
      blob: null, elevations: null, coverage: null,
      source: 'swiss-unavailable', allPermanentMissing: false, pendingFetches: null,
    };
  }

  // Construit un index rapide des bornes LV95 pour choisir le bon COG par pixel
  // sans parcours linéaire.
  // Les cellules font 1 km × 1 km, alignées sur des km entiers — la recherche est triviale.
  const cellByKey = new Map();
  for (const c of usableCells) cellByKey.set(`${c.Ekm}/${c.Nkm}`, c);
  // Index url → cog, pour que le regroupement de préchargement / l'instantané
  // évitent des recherches en O(cellules).
  const cogByUrl = new Map();
  for (const c of usableCells) cogByUrl.set(c.cog.url, c.cog);

  const n = 1 << mercZ;

  // ── Choix du LOD : le niveau de pyramide le plus grossier dont le pixelScale
  // correspond encore à la résolution de sortie. Comme ce que fait déjà
  // shouldUseIGN() en France : inutile de dépenser de la bande passante sur des
  // données natives à 0,5 m quand le pixel Mercator rendu fait par exemple 8 m.
  // Les COG swisstopo embarquent 4 à 5 IFD d'aperçu (1 m, 2 m, 4 m, 8 m, 16 m) :
  // la plupart des dézooms se servent avec une seule tuile d'aperçu par cellule
  // au lieu de dizaines de tuiles natives. Le niveau choisi est le même pour
  // toutes les cellules d'une tuile Mercator (même latitude → même m/px).
  const tileCenterLat = mercatorYToLat((mercY + 0.5) / n);
  const mppOut = (40075016.686 * Math.cos((tileCenterLat * Math.PI) / 180)) / (256 * n);
  // Vise un pixel source d'environ la moitié du pixel de sortie, pour que le
  // bilinéaire garde le détail. Plafonné en bas à la résolution native (0,5 m).
  const mppTarget = Math.max(0.5, mppOut * 0.6);
  // pickSwissCOGLevel est défini dans swiss-cog.js ; toutes les cellules
  // partagent la même structure de pyramide (les COG swisstopo sont uniformes).
  const pickedLevels = new Map(); // cellKey → level descriptor
  for (const c of usableCells) {
    const lvlIdx = pickSwissCOGLevel(c.cog, mppTarget);
    pickedLevels.set(`${c.Ekm}/${c.Nkm}`, { idx: lvlIdx, level: c.cog.levels[lvlIdx] });
  }

  // Step 2 — resample
  const totalPixels = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const elevations = new Float32Array(totalPixels);
  const coverage = new Uint8Array(totalPixels);

  // ── Pré-passe unique en 256×256. Pour chaque pixel de sortie : reprojection en
  // LV95, affectation à sa cellule COG et au niveau de pyramide choisi,
  // regroupement par tuile interne principale (pour que l'échantillonneur
  // itère localement), ET accumulation de l'ensemble exact des tuiles internes
  // que lira l'échantillonneur bilinéaire — le tout en un seul balayage.
  // L'ancien code faisait DEUX boucles en pleine résolution (une pour
  // regrouper, une pour recalculer les tuiles des coins bilinéaires) ; les
  // fusionner divise par deux le CPU par pixel et évite un recalcul redondant.
  //
  // pixelsByTile: Map<groupKey, { cog, levelIdx, pts:[{outIdx,E,N}] }>
  // tilePrefetchSet: Set<`${url}|${levelIdx}|${tileIndex}`>
  const pixelsByTile = new Map();
  const tilePrefetchSet = new Set();
  let droppedOutside = 0;

  for (let py = 0; py < DEM_TILE_SIZE; py++) {
    const yFrac = (mercY + (py + 0.5) / DEM_TILE_SIZE) / n;
    const lat = mercatorYToLat(yFrac);
    for (let px = 0; px < DEM_TILE_SIZE; px++) {
      const xFrac = (mercX + (px + 0.5) / DEM_TILE_SIZE) / n;
      const lng = xFrac * 360 - 180;
      const { E, N } = wgs84ToLV95(lng, lat);
      const Ekm = Math.floor(E / 1000);
      const Nkm = Math.floor(N / 1000);
      const cellKey = `${Ekm}/${Nkm}`;
      const cell = cellByKey.get(cellKey);
      if (!cell) { droppedOutside++; continue; }

      const cog = cell.cog;
      const picked = pickedLevels.get(cellKey);
      const level = picked.level;
      const lvl = picked.idx;
      const tileW = level.tileW;
      const tileH = level.tileH;
      const across = level.tilesAcross;
      const widthM1 = level.width - 1;
      const heightM1 = level.height - 1;

      // Empreinte bilinéaire de ce pixel au niveau de pyramide choisi.
      const ipx = (E - cog.originE) / level.pixelScaleX;
      const ipy = (cog.originN - N) / level.pixelScaleY;
      const x0 = Math.max(0, Math.min(Math.floor(ipx), widthM1));
      const y0 = Math.max(0, Math.min(Math.floor(ipy), heightM1));
      const x1 = Math.min(x0 + 1, widthM1);
      const y1 = Math.min(y0 + 1, heightM1);
      const tx0 = (x0 / tileW) | 0;
      const tx1 = (x1 / tileW) | 0;
      const ty0 = (y0 / tileH) | 0;
      const ty1 = (y1 / tileH) | 0;
      const primaryTile = ty0 * across + tx0;

      const groupKey = `${cellKey}#L${lvl}#${primaryTile}`;
      let bucket = pixelsByTile.get(groupKey);
      if (!bucket) {
        bucket = { cog, levelIdx: lvl, pts: [] };
        pixelsByTile.set(groupKey, bucket);
      }
      bucket.pts.push({ outIdx: py * DEM_TILE_SIZE + px, E, N });

      // Tuiles internes exactes que lit l'échantillonneur bilinéaire :
      // (x0,y0)(x1,y0)(x0,y1)(x1,y1). La plupart des pixels intérieurs n'en
      // touchent qu'une.
      const url = cog.url;
      tilePrefetchSet.add(`${url}|${lvl}|${primaryTile}`);
      if (tx1 !== tx0) tilePrefetchSet.add(`${url}|${lvl}|${ty0 * across + tx1}`);
      if (ty1 !== ty0) tilePrefetchSet.add(`${url}|${lvl}|${ty1 * across + tx0}`);
      if (tx1 !== tx0 && ty1 !== ty0) tilePrefetchSet.add(`${url}|${lvl}|${ty1 * across + tx1}`);
    }
  }

  if (pixelsByTile.size === 0) {
    // Même logique que plus haut : si STAC a été passager, on a pu manquer les
    // cellules qui couvrent cette tuile — on n'empoisonne pas le cache.
    if (!stacHadTransientFailure) swissAreaNegSet(mercZ, mercX, mercY);
    return {
      blob: null, elevations: null, coverage: null,
      source: stacHadTransientFailure ? 'swiss-unavailable' : 'swiss-empty',
      allPermanentMissing: !stacHadTransientFailure,
      pendingFetches: null,
    };
  }

  // Étape 2b — préchargement de plages regroupées. On groupe les tuiles internes
  // nécessaires par (COG, niveau) et swiss-fetcher fusionne les plages d'octets
  // contiguës en une seule requête HTTP chacune (swisstopo range les tuiles d'un
  // niveau de façon contiguë : la plupart des cellules à plusieurs tuiles se
  // réduisent à UN fetch au lieu de N). Tous les fetchs partagent le limiteur
  // SWISS_CONCURRENCY : la file n'est jamais inondée.
  const prefetchByCog = new Map(); // `${url}|${lvl}` → { cog, levelIdx, tiles:[] }
  for (const k of tilePrefetchSet) {
    const bar1 = k.indexOf('|');
    const bar2 = k.indexOf('|', bar1 + 1);
    const url = k.slice(0, bar1);
    const lvl = parseInt(k.slice(bar1 + 1, bar2), 10);
    const tileIndex = parseInt(k.slice(bar2 + 1), 10);
    const gk = `${url}|${lvl}`;
    let g = prefetchByCog.get(gk);
    if (!g) {
      const cog = cogByUrl.get(url);
      if (!cog) continue;
      g = { cog, levelIdx: lvl, tiles: [] };
      prefetchByCog.set(gk, g);
    }
    g.tiles.push(tileIndex);
  }
  const prefetchCount = tilePrefetchSet.size;
  await Promise.all(
    Array.from(prefetchByCog.values()).map((g) =>
      prefetchCOGTilesCoalesced(g.cog, g.levelIdx, g.tiles),
    ),
  );

  // Copie des tuiles décodées dans une map locale (références fortes), pour
  // qu'une éviction LRU déclenchée par des constructions Mercator concurrentes
  // ne puisse pas retirer une tuile sous les pieds de l'échantillonneur
  // synchrone en pleine passe.
  const tileMap = new Map(); // `${url}#L${lvl}#${tileIndex}` → Float32Array
  for (const k of tilePrefetchSet) {
    const bar1 = k.indexOf('|');
    const bar2 = k.indexOf('|', bar1 + 1);
    const url = k.slice(0, bar1);
    const lvl = parseInt(k.slice(bar1 + 1, bar2), 10);
    const tileIndex = parseInt(k.slice(bar2 + 1), 10);
    const cog = cogByUrl.get(url);
    if (!cog) continue;
    const t = getCOGInternalTileCached(cog, lvl, tileIndex);
    if (t) tileMap.set(`${url}#L${lvl}#${tileIndex}`, t);
  }
  const getTileSync = (cog, levelIdx, tileIndex) =>
    tileMap.get(`${cog.url}#L${levelIdx}#${tileIndex}`) || null;

  // Étape 3 — échantillonne chaque pixel de façon SYNCHRONE depuis les tuiles
  // décodées. L'ancien chemin attendait 4 lectures de cache par pixel (~260 k
  // microtâches par tuile) ; celui-ci lit directement les Float32Array et est
  // d'un ordre de grandeur plus rapide.
  let coveredCount = 0;
  for (const { cog, levelIdx, pts } of pixelsByTile.values()) {
    for (const { outIdx, E, N } of pts) {
      const v = sampleSwissCOGSync(cog, levelIdx, E, N, getTileSync);
      if (Number.isFinite(v)) {
        elevations[outIdx] = v;
        coverage[outIdx] = 1;
        coveredCount++;
      }
    }
  }

  if (coveredCount === 0) {
    // 0 pixel couvert peut aussi être le symptôme de fetchs de plages expirés
    // (aucune tuile interne décodée → sampleSwissCOG renvoie NaN). On
    // n'empoisonne pas pour de bon un bloc 2×2 pour un hoquet passager d'AWS.
    const rangeLikelyTransient = prefetchCount > 0; // we tried but got nothing
    if (!stacHadTransientFailure && !rangeLikelyTransient) {
      swissAreaNegSet(mercZ, mercX, mercY);
    }
    console.warn(
      `[swiss][build] ${mercZ}/${mercX}/${mercY} \u2192 0 covered px (cells=${usableCells.length} tiles=${pixelsByTile.size} dropped=${droppedOutside} stacTransient=${stacHadTransientFailure} prefetch=${prefetchCount}) ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return {
      blob: null, elevations: null, coverage: null,
      source: (stacHadTransientFailure || rangeLikelyTransient) ? 'swiss-unavailable' : 'swiss-empty',
      allPermanentMissing: !(stacHadTransientFailure || rangeLikelyTransient),
      pendingFetches: null,
    };
  }

  // Despike LiDAR hot pixels (vegetation tops, scanner artefacts)
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);

  if (typeof swLog !== 'undefined' && swLog.isDebug()) {
    const dt = (performance.now() - t0).toFixed(0);
    const covPct = (coveredCount / totalPixels * 100).toFixed(1);
    // Résumé des niveaux choisis, pour le diagnostic
    const lvlSet = new Set();
    for (const v of pickedLevels.values()) lvlSet.add(v.idx);
    const lvlSummary = Array.from(lvlSet).sort().map((i) => `L${i}@${usableCells[0].cog.levels[i].pixelScaleX.toFixed(1)}m`).join(',');
    swLog.debug(
      'swiss',
      `%c \u2713 swiss %c ${mercZ}/${mercX}/${mercY} \u2014 cov ${covPct}%, cells=${usableCells.length}, tiles=${pixelsByTile.size}, prefetched=${prefetchCount}, levels=${lvlSummary} (out=${mppOut.toFixed(1)}m), ${dt}ms`,
      'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '',
    );
  }

  // Le libellé de source indique l'année dominante, pour le diagnostic. On ne
  // tente pas ici de préremplissage Mapbox en couverture partielle —
  // composite.js gère déjà le fondu MNS↔Mapbox par le chemin de couverture
  // partielle commun utilisé pour l'IGN. coverage[] lui dit quels pixels sont réels.
  return {
    blob: null,
    elevations,
    coverage,
    source: 'swiss',
    allPermanentMissing: false,
    pendingFetches: null,
  };
}
