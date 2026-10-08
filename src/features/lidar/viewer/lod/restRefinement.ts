// ============================================
// Qualité caméra fixe : budget de raffinement + anticrénelage progressif
// ============================================
//
// Le budget de points est dimensionné pour les images en mouvement (une vsync
// chacune). Une fois la caméra arrêtée, plus rien ne doit être prêt en 16 ms :
// l'image fixe est raffinée en deux temps :
//  1. raffiner : le budget grandit jusqu'à ce que le GPU dessine en environ
//     REST_TARGET_MS par image (mesuré : le coût de la sélection fixe complète
//     est lu, puis le budget est mis à l'échelle vers la cible, au plus
//     MAX_ADJUSTMENTS fois ; borné par le plafond au repos de la plateforme).
//     Les nœuds plus profonds arrivent en flux et le lointain atteint la densité
//     à l'écran du premier plan. Le budget appris est repris pour les vues fixes
//     suivantes ;
//  2. accumuler : la sélection complète, REST_SAMPLES images sont rendues avec
//     des décalages sous-pixel (Halton 2,3) et moyennées en lumière linéaire
//     (`accumulate` du renderer) : chaque pixel finit comme la moyenne de ce
//     qu'il couvre, comme le donnerait un suréchantillonnage 16× : pas de points
//     sous-pixel qui scintillent au loin, bords lisses, pas de disques de sprites crénelés.
// Puis la boucle de rendu se met au repos. Tout mouvement de caméra revient
// aussitôt au budget en mouvement (sa sélection est un préfixe de la sélection
// fixe, donc déjà résidente).

/** Images moyennées par l'anticrénelage progressif. */
export const REST_SAMPLES = 16;
/** Temps GPU visé pour une image fixe (quelques vsyncs : rien ne bouge). */
const REST_TARGET_MS = 50;
/** Le budget grandit tant qu'une image fixe complète coûte moins que cette part de la cible… */
const GROW_BELOW = 0.6;
/** …et diminue au-dessus de celle-ci. */
const SHRINK_ABOVE = 1.35;
/** Plus forte croissance d'un ajustement. */
const MAX_GROWTH = 2.5;
/** Images d'une sélection inchangée et entièrement chargée avant de lire son coût (le timer GPU est lissé). */
const MEASURE_FRAMES = 6;
const MAX_ADJUSTMENTS = 4;
/** Premier budget fixe, en multiple du budget en mouvement, avant toute mesure. */
const INITIAL_FACTOR = 3;
/** Une image fixe complète aussi lente arrête aussitôt le raffinement ou l'accumulation (sinon entrées poussives). */
const REST_ABORT_MS = 200;

export type RestPhase = 'moving' | 'refine' | 'accumulate' | 'done';

/** Inverse radical de `index` en base `base` (suite de Halton), dans [0, 1). */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/** Coût de l'image fixe qui vient d'être rendue. */
export interface RestFrameSample {
  /** Chaque nœud de la sélection est dessiné (aucun chargement en attente). */
  lodIdle: boolean;
  /** Coût GPU lissé des images (ms) ; intervalle entre images quand le GPU n'est pas chronométré. */
  gpuMs: number;
  /** Le budget a coupé la sélection (plus de points seraient dessinés avec un budget plus grand). */
  budgetLimited: boolean;
}

export class RestRefinement {
  phase: RestPhase = 'moving';
  /** Indice de la prochaine image accumulée (0 = image simple, remplace l'historique). */
  sample = 0;
  /** Images moyennées par vue fixe. */
  samples = REST_SAMPLES;
  /** Temps GPU visé pour une image fixe complète (ms). */
  private targetMs = REST_TARGET_MS;
  /** Budget fixe appris (points, avant le curseur de densité) ; 0 jusqu'à la première vue fixe. */
  private restBudget = 0;
  private stableFrames = 0;
  private adjustments = 0;
  private readonly enabled: boolean;

  /** @param enabled false garde chaque image au budget en mouvement, sans accumulation (benchs à budget figé). */
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** La caméra bouge : budget en mouvement, pas d'accumulation. */
  setMoving(): void {
    this.phase = 'moving';
    this.sample = 0;
  }

  /** Caméra fixe et budget en mouvement stabilisé avec sa sélection dessinée : commencer le raffinement. */
  startRefine(): void {
    if (this.phase !== 'moving') return;
    this.enterRefine();
  }

  /**
   * Quelque chose a changé à l'écran (surcouche, couleurs, densité, nouveau
   * nœud…) : l'historique moyenné est périmé. La sélection fixe est revérifiée
   * (elle peut demander des chargements) avant une nouvelle accumulation.
   */
  invalidate(): void {
    if (this.phase === 'accumulate' || this.phase === 'done') this.enterRefine();
  }

  private enterRefine(): void {
    this.phase = this.enabled ? 'refine' : 'done';
    this.sample = 0;
    this.stableFrames = 0;
    this.adjustments = 0;
  }

  /**
   * Budget de l'image fixe (points, avant le curseur de densité) à partir du
   * budget brut en mouvement, dans [budget en mouvement, plafond au repos].
   */
  budget(movingBudget: number, restCeiling: number): number {
    if (this.phase === 'moving' || !this.enabled) return movingBudget;
    if (this.restBudget <= 0) this.restBudget = movingBudget * INITIAL_FACTOR;
    this.restBudget = Math.max(movingBudget, Math.min(restCeiling, this.restBudget));
    return Math.round(this.restBudget);
  }

  /**
   * Après une image de raffinement : une fois la sélection complète depuis
   * quelques images, son coût met le budget à l'échelle vers REST_TARGET_MS
   * (d'autres chargements suivent), ou l'accumulation commence.
   */
  onRefineFrame(frame: RestFrameSample, movingBudget: number, restCeiling: number): void {
    if (this.phase !== 'refine') return;
    if (!frame.lodIdle) {
      this.stableFrames = 0;
      return;
    }
    if (frame.gpuMs > REST_ABORT_MS) {
      // Une image fixe complète déjà aussi lente (rastériseur logiciel, GPU
      // faible) : raffiner et moyenner garderaient la vue poussive pendant de
      // nombreuses secondes. Cette image est l'image finale ; les vues fixes
      // suivantes partent de la moitié du budget.
      this.restBudget = Math.max(movingBudget, this.restBudget * 0.5);
      this.phase = 'done';
      return;
    }
    if (++this.stableFrames < MEASURE_FRAMES) return;
    this.stableFrames = 0;
    if (frame.gpuMs > 0 && this.adjustments < MAX_ADJUSTMENTS) {
      const target = this.targetMs;
      if (frame.budgetLimited && frame.gpuMs < target * GROW_BELOW && this.restBudget < restCeiling) {
        this.restBudget = Math.min(restCeiling, this.restBudget * Math.min(MAX_GROWTH, (target * 0.85) / frame.gpuMs));
        this.adjustments++;
        return;
      }
      if (frame.gpuMs > target * SHRINK_ABOVE && this.restBudget > movingBudget) {
        this.restBudget = Math.max(movingBudget, this.restBudget * Math.max(0.5, target / frame.gpuMs));
        this.adjustments++;
        return;
      }
    }
    this.phase = 'accumulate';
    this.sample = 0;
  }

  /** Décalage sous-pixel (px du canvas, dans ±0,5) de l'image sur le point d'être accumulée. */
  jitter(): [number, number] {
    if (this.phase !== 'accumulate' || this.sample === 0) return [0, 0];
    return [halton(this.sample, 2) - 0.5, halton(this.sample, 3) - 0.5];
  }

  /** Après une image accumulée (`gpuMs` comme dans RestFrameSample). */
  onAccumulatedFrame(gpuMs: number, movingBudget: number): void {
    if (this.phase !== 'accumulate') return;
    if (gpuMs > REST_ABORT_MS) {
      this.restBudget = Math.max(movingBudget, this.restBudget * 0.5);
      this.phase = 'done';
      return;
    }
    this.sample++;
    if (this.sample >= this.samples) this.phase = 'done';
  }

  /** Images fixes restant à rendre avant que l'image soit finale. */
  get pending(): boolean {
    return this.phase === 'refine' || this.phase === 'accumulate';
  }
}
