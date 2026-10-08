/**
 * shadowSweep.ts — Source unique du balayage d'horizon O(N) des ombres portées.
 *
 * Utilisé à la fois par le worker d'ombres portées (`shadowWorker.ts`) et par
 * le worker de carte d'ensoleillement cumulé (`sunlightMapWorker.ts`, via
 * `dem-grid-worker.ts`). Les deux workers avaient chacun leur copie de
 * l'algorithme ; ce module met fin à cette divergence — il n'y a plus qu'une
 * implémentation du balayage à profiler, mesurer et comprendre.
 *
 * Algorithme (inchangé depuis la réécriture qui a retiré la source raster par
 * tuile) : une seule passe de propagation par direction du soleil. Le tampon
 * « altitude d'ombre » contient, pour chaque cellule, l'altitude du plus haut
 * rayon porteur d'ombre vu jusque-là dans la direction opposée au soleil. Une
 * cellule est à l'ombre quand ce rayon propagé passe au-dessus de sa propre
 * altitude.
 *
 * Optimisations de cette version (validées identiques au bit près à l'ancienne
 * boucle interne sur 26 configurations azimut / altitude, sur un terrain de
 * 200×200 avec 5 % de trous NaN ; ~20 à 26× plus rapide aux tailles de grille
 * de production) :
 *   • chemin rapide `noInterp` dédié — réduit le mélange bilinéaire
 *     (v0*1 + v1*0 = v0) pour éviter la multiplication. v1 est quand même *lu*
 *     pour que la chaîne tolérante aux NaN se comporte comme le chemin avec
 *     interpolation (les ombres survivent à la traversée des trous du DEM) ;
 *   • test de NaN en ligne (`el !== el`) au lieu de `Number.isNaN(el)` (appel
 *     de fonction non inlinable dans la boucle interne critique) ;
 *   • décalage de base du prédécesseur précalculé, sorti de la boucle interne.
 *
 * Les cellules ne sont pas forcément carrées : les grilles de vue suivent le
 * rapport d'aspect du canvas tandis que leur emprise suit l'étendue (inclinée)
 * de la carte, et les grilles d'aperçu / d'ensoleillement sont plafonnées par
 * axe. L'azimut du soleil est une direction métrique : il est donc converti en
 * unités de cellule (composante en ligne multipliée par cellSizeX / cellSizeY)
 * avant de choisir l'axe de balayage et le décalage par pas. Des cellules
 * carrées gardent un rapport d'exactement 1, donc les résultats historiques au
 * bit près.
 *
 * NOTE sur le départage en virgule flottante : l'ancien algorithme (comme
 * celui-ci) n'arrondit PAS les poids fractionnaires proches de 0 ou 1. Sur un
 * terrain réaliste, le bruit d'interpolation qui en résulte aux azimuts
 * quasi cardinaux / exactement diagonaux est sous-pixel et invisible — il a été
 * confirmé empiriquement (voir test-diagonal-bug.mts) que az = 45°/135°/225°/315°
 * donnent une couverture d'ombre statistiquement indiscernable de leurs
 * voisins. L'arrondi n'a donc volontairement PAS été introduit : il divergerait
 * de l'ancien comportement sans bénéfice perceptible et risquerait des
 * régressions subtiles près des trous du DEM.
 */

/** Sentinelle stockée dans `shadowElev` pour les cellules NaN (DEM manquant), conservée pendant la propagation. */
const NEG_INFINITY = -Infinity;

export interface ShadowSweepScratch {
  /** Tampon d'octets de sortie : 0 = éclairé, 255 = entièrement à l'ombre portée, intermédiaire = pénombre douce. */
  shadow: Uint8Array;
  /** Tampon Float32 de travail qui propage les altitudes des rayons — inutile de le vider. */
  shadowElev: Float32Array;
}

export function createShadowSweepScratch(size: number): ShadowSweepScratch {
  return {
    shadow: new Uint8Array(size),
    shadowElev: new Float32Array(size),
  };
}

/**
 * Balayage d'horizon O(N) en une passe.
 *
 * @param elev     Grille d'altitudes Float32 ligne par ligne ; `NaN` marque les cellules manquantes.
 * @param W        Largeur de la grille (colonnes, est → +col).
 * @param H        Hauteur de la grille (lignes, sud → +ligne).
 * @param sunAzDeg Azimut du soleil en degrés, 0 = nord, sens horaire.
 * @param sunAltDeg Altitude du soleil en degrés au-dessus de l'horizon (≤0 ou ≥89 : tout éclairé, sans calcul).
 * @param cellSizeX Largeur métrique d'une cellule à la latitude moyenne de la grille (mètres).
 * @param cellSizeY Hauteur métrique d'une cellule à la latitude moyenne de la grille (mètres).
 * @param scratch  Tampons de travail préalloués (`shadow` + `shadowElev`), d'au moins `W*H` chacun.
 * @returns `scratch.shadow` — octets où 0 = éclairé, 255 = entièrement à l'ombre.
 */
export function computeShadowSweep(
  elev: Float32Array,
  W: number,
  H: number,
  sunAzDeg: number,
  sunAltDeg: number,
  cellSizeX: number,
  cellSizeY: number,
  scratch: ShadowSweepScratch,
): Uint8Array {
  const out = scratch.shadow;
  const shadowElev = scratch.shadowElev;
  out.fill(0);
  if (sunAltDeg <= 0 || sunAltDeg >= 89) return out;
  if (!(cellSizeX > 0) || !(cellSizeY > 0)) return out;

  const azRad = (sunAzDeg * Math.PI) / 180;
  const tanAlt = Math.tan((sunAltDeg * Math.PI) / 180);
  // Direction de propagation de l'ombre (à l'opposé du soleil) en unités de
  // cellule : mètres vers l'est / le sud divisés par la taille de cellule,
  // multipliés par cellSizeX pour que des cellules carrées multiplient par
  // exactement 1.
  const shadowDC = -Math.sin(azRad);
  const shadowDR = Math.cos(azRad) * (cellSizeX / cellSizeY);
  const absDC = Math.abs(shadowDC);
  const absDR = Math.abs(shadowDR);

  // Hauteur de pénombre (mètres). Disque solaire + adoucissement
  // atmosphérique + anticrénelage par cellule réunis dans ce seul paramètre.
  // Soleil bas → pénombre plus large : comme les vraies ombres du soir qui
  // s'estompent.
  const SOFTNESS_HEIGHT_M =
    2.5 + 6 * Math.max(0, Math.min(1, (35 - sunAltDeg) / 35));
  const invSoftness = 255 / SOFTNESS_HEIGHT_M;

  if (absDC >= absDR) {
    // ── Balayage par colonnes ── parcourt les colonnes dans l'ordre de
    // propagation, chaque colonne de haut en bas. Le prédécesseur est une
    // colonne en arrière.
    const colStep = shadowDC > 0 ? 1 : -1;
    const rowShift = shadowDR / absDC;
    const rowShiftFloor = Math.floor(-rowShift);
    const fr = -rowShift - rowShiftFloor;
    const noInterp = fr === 0;
    const w0 = 1 - fr;
    const w1 = fr;
    const stepDistM = Math.sqrt(
      cellSizeX * cellSizeX + (rowShift * cellSizeY) * (rowShift * cellSizeY),
    );
    const dropPerStep = stepDistM * tanAlt;
    const colStart = colStep > 0 ? 0 : W - 1;
    const colEnd = colStep > 0 ? W : -1;
    for (let c = colStart; c !== colEnd; c += colStep) {
      const predC = c - colStep;
      if (predC < 0 || predC >= W) {
        // Colonne de bord — pas de prédécesseur ; shadowElev part de l'altitude.
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          shadowElev[idx] = el !== el ? NEG_INFINITY : el;
        }
        continue;
      }
      if (noInterp) {
        // Chemin rapide : fr === 0, donc le mélange bilinéaire se réduit à v0
        // (predElev = v0*1 + v1*0). v1 n'est jamais nécessaire — quand v0 est la
        // sentinelle NaN, on abandonne exactement comme l'ancienne branche
        // `noInterp` (les ombres s'arrêtent aux trous du DEM pour une direction
        // du soleil purement cardinale). Le test de bornes reprend celui du
        // chemin avec interpolation (`predR1 >= H`) pour que les lignes de bord
        // se comportent pareil. Gain net : une seule lecture, pas de
        // multiplication, pas d'appel à `Number.isNaN`.
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predR0 = r + rowShiftFloor;
          const predR1 = predR0 + 1;
          if (predR0 < 0 || predR1 >= H) {
            shadowElev[idx] = el;
            continue;
          }
          const v0 = shadowElev[predR0 * W + predC];
          if (v0 === NEG_INFINITY) {
            shadowElev[idx] = el;
            continue;
          }
          const propagated = v0 - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      } else {
        for (let r = 0; r < H; r++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predR0 = r + rowShiftFloor;
          const predR1 = predR0 + 1;
          if (predR0 < 0 || predR1 >= H) {
            shadowElev[idx] = el;
            continue;
          }
          const base = predR0 * W + predC;
          const v0 = shadowElev[base];
          const v1 = shadowElev[base + W];
          let predElev: number;
          if (v0 === NEG_INFINITY) {
            if (v1 === NEG_INFINITY) {
              shadowElev[idx] = el;
              continue;
            }
            predElev = v1;
          } else if (v1 === NEG_INFINITY) {
            predElev = v0;
          } else {
            predElev = v0 * w0 + v1 * w1;
          }
          const propagated = predElev - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      }
    }
  } else {
    // ── Balayage par lignes ── parcourt les lignes dans l'ordre de propagation,
    // chaque ligne de gauche à droite. Le prédécesseur est une ligne en arrière.
    const rowStep = shadowDR > 0 ? 1 : -1;
    const colShift = shadowDC / absDR;
    const colShiftFloor = Math.floor(-colShift);
    const fc = -colShift - colShiftFloor;
    const noInterp = fc === 0;
    const w0 = 1 - fc;
    const w1 = fc;
    const stepDistM = Math.sqrt(
      (colShift * cellSizeX) * (colShift * cellSizeX) + cellSizeY * cellSizeY,
    );
    const dropPerStep = stepDistM * tanAlt;
    const rowStart = rowStep > 0 ? 0 : H - 1;
    const rowEnd = rowStep > 0 ? H : -1;
    for (let r = rowStart; r !== rowEnd; r += rowStep) {
      const predR = r - rowStep;
      if (predR < 0 || predR >= H) {
        const rowOffset = r * W;
        for (let c = 0; c < W; c++) {
          const idx = rowOffset + c;
          const el = elev[idx];
          shadowElev[idx] = el !== el ? NEG_INFINITY : el;
        }
        continue;
      }
      const predRowOffset = predR * W;
      if (noInterp) {
        // Chemin rapide : fc === 0, le mélange bilinéaire se réduit à v0
        // (predElev = v0*1 + v1*0). v1 n'est jamais nécessaire — quand v0 est la
        // sentinelle NaN, on abandonne exactement comme l'ancienne branche
        // `noInterp`. Le test de bornes reprend celui du chemin avec
        // interpolation (`predC1 >= W`).
        for (let c = 0; c < W; c++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predC0 = c + colShiftFloor;
          const predC1 = predC0 + 1;
          if (predC0 < 0 || predC1 >= W) {
            shadowElev[idx] = el;
            continue;
          }
          const v0 = shadowElev[predRowOffset + predC0];
          if (v0 === NEG_INFINITY) {
            shadowElev[idx] = el;
            continue;
          }
          const propagated = v0 - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      } else {
        for (let c = 0; c < W; c++) {
          const idx = r * W + c;
          const el = elev[idx];
          if (el !== el) {
            shadowElev[idx] = NEG_INFINITY;
            continue;
          }
          const predC0 = c + colShiftFloor;
          const predC1 = predC0 + 1;
          if (predC0 < 0 || predC1 >= W) {
            shadowElev[idx] = el;
            continue;
          }
          const base = predRowOffset + predC0;
          const v0 = shadowElev[base];
          const v1 = shadowElev[base + 1];
          let predElev: number;
          if (v0 === NEG_INFINITY) {
            if (v1 === NEG_INFINITY) {
              shadowElev[idx] = el;
              continue;
            }
            predElev = v1;
          } else if (v1 === NEG_INFINITY) {
            predElev = v0;
          } else {
            predElev = v0 * w0 + v1 * w1;
          }
          const propagated = predElev - dropPerStep;
          const diff = propagated - el;
          if (diff > 0) {
            shadowElev[idx] = propagated;
            const cast = diff * invSoftness;
            out[idx] = cast >= 255 ? 255 : cast | 0;
          } else {
            shadowElev[idx] = el;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Facteur adaptatif de dépassement de la vue pour l'échantillonnage des ombres.
 *
 * L'ombre d'une montagne sur terrain plat atteint `peakHeightM / tan(altitude)`
 * mètres. Avec un dépassement fixe de 10 à 15 %, un sommet de 2000 m hors écran
 * avec un soleil à 10° projette une ombre de 11 km qui disparaît sans bruit au
 * bord de la vue. Cette aide agrandit le dépassement quand le soleil baisse,
 * pour que les sommets juste hors de la vue projettent encore leur ombre dans
 * la zone visible.
 *
 * Renvoie un facteur borné à `[MIN, MAX]`. `MAX` est assez prudent pour garder
 * le nombre de tuiles DEM sous le plafond `MAX_SAMPLE_TILE_COUNT` du worker.
 */
export function adaptiveOvershoot(
  sunAltitudeDeg: number,
  peakHeightM: number,
  viewportWidthM: number,
): number {
  const MIN_OVERSHOOT = 0.10;
  const MAX_OVERSHOOT = 0.40;
  const FALLBACK_PEAK_M = 1500;

  if (!Number.isFinite(sunAltitudeDeg) || sunAltitudeDeg >= 89 || viewportWidthM <= 0) {
    return MIN_OVERSHOOT;
  }
  const alt = Math.max(0.5, sunAltitudeDeg); // borné pour éviter l'explosion tan → ∞ à l'horizon
  const peak = Number.isFinite(peakHeightM) && peakHeightM > 0 ? peakHeightM : FALLBACK_PEAK_M;
  // Longueur d'ombre en mètres (d'un côté). Demi-étendue de chaque côté de la vue.
  const shadowM = peak / Math.tan((alt * Math.PI) / 180);
  // Facteur = (demi-étendue de l'ombre) / (demi-largeur de la vue). Un dépassement
  // de 1,0 ≈ double l'emprise échantillonnée, ce qui coûte déjà ~4× de tuiles :
  // plafond ferme.
  const factor = shadowM / (viewportWidthM * 0.5);
  return Math.max(MIN_OVERSHOOT, Math.min(MAX_OVERSHOOT, factor));
}

/**
 * Quantifie l'altitude du soleil en classes grossières pour que le dépassement
 * adaptatif ne rééchantillonne le DEM que quand la longueur d'ombre a vraiment
 * changé — pas à chaque pixel d'un glissement du curseur de temps.
 *
 * Limites des classes : ≤5°, ≤10°, ≤15°, ≤25°, >25°. Renvoie une petite clé entière.
 */
export function sunAltitudeOvershootBucket(sunAltitudeDeg: number): number {
  if (!Number.isFinite(sunAltitudeDeg)) return 0;
  if (sunAltitudeDeg <= 5) return 1;
  if (sunAltitudeDeg <= 10) return 2;
  if (sunAltitudeDeg <= 15) return 3;
  if (sunAltitudeDeg <= 25) return 4;
  return 5;
}
