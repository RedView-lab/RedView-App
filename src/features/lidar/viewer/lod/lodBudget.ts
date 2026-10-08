import type { PlatformProfile } from './types';

// Le budget vise la cadence de l'écran, pas 16,6 ms fixes de travail GPU :
// une image dont les passes prennent 17 ms rate un vsync sur deux sur un
// écran à 60 Hz (30 i/s perçues), et le compositeur, le flou des panneaux et
// le chargement en flux ont aussi besoin de leur part de l'intervalle. Le coût
// mesuré seul ne suffit pas : un GPU qui a de la marge baisse sa fréquence, si
// bien que la durée de ses passes tourne autour de 60–75 % de l'intervalle
// quelle que soit la charge (mesuré sur un Radeon intégré). Le coût ne fait
// donc que borner le budget (croissance sous 75 %, baisse au-dessus de 90 %
// de l'intervalle) et la cadence réelle (intervalles de rAF) tranche près de
// la limite : pas de croissance tant que des images ratent le vsync, et une
// baisse quand elles continuent de le rater alors que le GPU porte une vraie
// part de l'image. Une baisse plafonne aussi la croissance juste sous le
// budget qui était de trop, pour que le budget ne repasse pas la limite
// chaque seconde (une partie du coût de l'image échappe aux horodatages) ; le
// plafond se relâche lentement tant que la cadence tient, à mesure que la vue
// change.
// Les images fixes sont rendues en pleine résolution alors que les images en
// mouvement peuvent être réduites : le budget est dimensionné sur les images
// en mouvement ; une image fixe ne peut que le faire croître (elle coûte au
// moins autant qu'une image en mouvement) ou couper une image pathologique.

/** Images mesurées avant que le budget commence à s'adapter. */
const FRAME_WINDOW = 8;
/** Une seule image plus lente que ce multiple de l'intervalle visé divise aussitôt le budget par deux… */
const EMERGENCY_FRAME_FACTOR = 3;
/** …ou que celui-ci pour une image fixe (pleine résolution, sa cadence ne se voit pas). */
const REST_EMERGENCY_FRAME_FACTOR = 6;
const EMERGENCY_COOLDOWN_FRAMES = 6;
/** Images sans changement de budget avant qu'il soit considéré comme stabilisé. */
const SETTLED_FRAMES = 8;
/** Images au plancher du budget et toujours lentes avant de baisser les réglages de rendu. */
const STARVED_FRAMES = 20;
/** Parts de l'intervalle visé : le coût moyen fait baisser le budget au-dessus de SLOW, le laisse croître sous FAST. */
const SLOW_COST_SHARE = 0.9;
const FAST_COST_SHARE = 0.75;
/** Taux moyen de vsyncs ratés qui compte comme lent (quand le GPU est chargé) ou bloque la croissance. */
const MISSED_SLOW_RATE = 0.2;
const MISSED_GROW_RATE = 0.05;
/** Part GPU de l'intervalle visé au-delà de laquelle les vsyncs ratés sont imputés au nombre de points. */
const GPU_LOADED_SHARE = 0.45;
const AVERAGE_ALPHA = 1 / 8;
/** Après une baisse, la croissance s'arrête à cette part du budget qui était de trop… */
const CEILING_SHARE = 0.95;
/** …et ce plafond monte de CEILING_RELAX toutes les CEILING_RELAX_FRAMES images en mouvement sans vsync raté. */
const CEILING_RELAX = 1.01;
const CEILING_RELAX_FRAMES = 60;

/** Coût d'une image et la cadence à laquelle elle a tourné. */
export interface BudgetSample {
  /** Coût GPU des passes de dessin (ms) ; 0 tant qu'il n'est pas mesuré. */
  gpuMs: number;
  /** Temps JS de la boucle de rendu (ms). */
  cpuMs: number;
  /** Intervalle depuis l'image rendue précédente (ms) ; 0 pour la première image d'une série. */
  intervalMs: number;
  /** Intervalle d'image visé (ms), multiple de la période de rafraîchissement (voir FrameClock). */
  targetIntervalMs: number;
  /** Display refresh period (ms). */
  refreshMs: number;
  /** Caméra immobile : l'image peut faire croître le budget, jamais le faire baisser (sauf image pathologique). */
  rest?: boolean;
}

export interface LodBudgetState {
  pointBudget: number;
  minBudget: number;
  maxBudget: number;
  /**
   * Faux quand le chiffre GPU est la latence envoi→fin (pas de
   * `timestamp-query`) : il inclut l'attente du vsync, donc seuls le temps
   * CPU et la cadence sont fiables.
   */
  preciseGpu: boolean;
  targetIntervalMs: number;
  /** Coût moyen d'une image (max du temps GPU et du temps CPU). */
  avgCostMs: number;
  avgGpuMs: number;
  /** Part moyenne des images qui ont raté au moins un vsync au-delà de la cible. */
  missedRate: number;
  framesSeen: number;
  slowFrameCount: number;
  fastFrameCount: number;
  /** Images restantes avant d'autoriser une nouvelle coupe d'urgence (les mesures ont quelques images de retard). */
  emergencyCooldown: number;
  /** Plafond de croissance appris des dernières baisses (≤ maxBudget). */
  ceiling: number;
  /** Images en mouvement depuis le dernier vsync raté ou le dernier pas du plafond. */
  cleanFrames: number;
}

/** Vrai quand l'image est arrivée au moins une demi-période de rafraîchissement après l'intervalle visé. */
function missedTarget(intervalMs: number, targetIntervalMs: number, refreshMs: number): boolean {
  return intervalMs > targetIntervalMs + refreshMs * 0.5;
}

/**
 * Des images lentes en continu multiplient le budget par 0,9, une plus longue
 * série d'images nettement rapides par 1,15 ; une seule image pathologique le
 * divise aussitôt par deux, pour qu'un GPU faible ne reste jamais plusieurs
 * secondes par image (TDR de Windows → device perdu).
 * La première image d'une série (`intervalMs` 0) n'apporte aucune information.
 */
function updateAdaptiveBudget(state: LodBudgetState, sample: BudgetSample): LodBudgetState {
  const target = sample.targetIntervalMs;
  const cooldown = Math.max(0, state.emergencyCooldown - 1);
  if (sample.intervalMs <= 0) {
    return { ...state, targetIntervalMs: target, emergencyCooldown: cooldown };
  }

  const cost = state.preciseGpu ? Math.max(sample.gpuMs, sample.cpuMs) : sample.cpuMs;
  const avgCostMs = state.avgCostMs + (Math.max(0.1, Math.min(cost, target * 4)) - state.avgCostMs) * AVERAGE_ALPHA;
  const avgGpuMs = state.avgGpuMs + (Math.min(sample.gpuMs, target * 4) - state.avgGpuMs) * AVERAGE_ALPHA;
  const missed = missedTarget(sample.intervalMs, target, sample.refreshMs) ? 1 : 0;
  const missedRate = state.missedRate + (missed - state.missedRate) * AVERAGE_ALPHA;
  const framesSeen = state.framesSeen + 1;
  let { ceiling, cleanFrames } = state;
  if (!sample.rest) {
    cleanFrames = missed ? 0 : cleanFrames + 1;
    if (cleanFrames >= CEILING_RELAX_FRAMES) {
      ceiling = Math.min(state.maxBudget, Math.ceil(ceiling * CEILING_RELAX));
      cleanFrames = 0;
    }
  }
  const measured = { ...state, targetIntervalMs: target, avgCostMs, avgGpuMs, missedRate, framesSeen, ceiling, cleanFrames };

  const emergencyFactor = sample.rest ? REST_EMERGENCY_FRAME_FACTOR : EMERGENCY_FRAME_FACTOR;
  if (cost > target * emergencyFactor && cooldown === 0) {
    return {
      ...measured,
      pointBudget: Math.max(state.minBudget, Math.floor(state.pointBudget * 0.5)),
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES,
    };
  }

  if (framesSeen < FRAME_WINDOW) {
    return { ...measured, emergencyCooldown: cooldown };
  }

  // Asymétrique et lent exprès : chaque pas de budget remanie la sélection du
  // LOD ; il baisse donc après une courte série d'images lentes et ne croît
  // qu'après une plus longue série d'images nettement rapides.
  let { pointBudget, slowFrameCount, fastFrameCount } = state;
  if (sample.rest && !isFast(measured)) {
    slowFrameCount = 0;
    fastFrameCount = 0;
  } else if (isSlow(measured)) {
    slowFrameCount++;
    fastFrameCount = 0;
    if (slowFrameCount >= 6) {
      ceiling = Math.max(state.minBudget, Math.min(ceiling, Math.floor(pointBudget * CEILING_SHARE)));
      pointBudget = Math.max(state.minBudget, Math.floor(pointBudget * 0.9));
      slowFrameCount = 0;
    }
  } else if (isFast(measured)) {
    fastFrameCount++;
    slowFrameCount = 0;
    if (fastFrameCount >= 12) {
      pointBudget = Math.max(pointBudget, Math.min(ceiling, Math.floor(pointBudget * 1.15)));
      fastFrameCount = 0;
    }
  } else {
    slowFrameCount = 0;
    fastFrameCount = 0;
  }

  return { ...measured, pointBudget, slowFrameCount, fastFrameCount, emergencyCooldown: cooldown, ceiling };
}

/** Les vsyncs ratés ne sont imputés au nombre de points que quand le GPU porte une vraie part de l'image. */
function gpuLoaded(state: LodBudgetState): boolean {
  return !state.preciseGpu || state.avgGpuMs >= state.targetIntervalMs * GPU_LOADED_SHARE;
}

function isSlow(state: LodBudgetState): boolean {
  return state.avgCostMs > state.targetIntervalMs * SLOW_COST_SHARE
    || (state.missedRate > MISSED_SLOW_RATE && gpuLoaded(state));
}

function isFast(state: LodBudgetState): boolean {
  return state.avgCostMs < state.targetIntervalMs * FAST_COST_SHARE && state.missedRate < MISSED_GROW_RATE;
}

/** Budget de points piloté par le coût et la cadence mesurés des images, mis à l'échelle par le curseur de densité de l'utilisateur. */
export class AdaptivePointBudget {
  private state: LodBudgetState;
  private framesSinceChange = 0;
  private starvedFrames = 0;
  private lastRest = false;
  /** User density slider (0.01–1). */
  userScale = 1;

  constructor(profile: PlatformProfile, options: { preciseGpu: boolean }) {
    const target = 1000 / 60;
    this.state = {
      pointBudget: profile.initialBudget,
      minBudget: Math.min(profile.initialBudget, profile.minBudget),
      maxBudget: profile.maxBudget,
      preciseGpu: options.preciseGpu,
      targetIntervalMs: target,
      avgCostMs: target * SLOW_COST_SHARE,
      avgGpuMs: 0,
      missedRate: 0,
      framesSeen: 0,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: 0,
      ceiling: profile.maxBudget,
      cleanFrames: 0,
    };
  }

  /** Feeds one rendered frame. */
  sample(sample: BudgetSample): void {
    const rest = sample.rest === true;
    if (rest !== this.lastRest) {
      // Les images fixes et en mouvement n'ont pas le même coût (résolution) :
      // aucune moyenne ne passe d'un mode à l'autre.
      this.lastRest = rest;
      this.state = {
        ...this.state,
        avgCostMs: this.state.targetIntervalMs * (SLOW_COST_SHARE + FAST_COST_SHARE) / 2,
        avgGpuMs: 0,
        missedRate: 0,
        framesSeen: 0,
        slowFrameCount: 0,
        fastFrameCount: 0,
      };
    }
    const next = updateAdaptiveBudget(this.state, sample);
    this.framesSinceChange = next.pointBudget === this.state.pointBudget ? this.framesSinceChange + 1 : 0;
    this.state = next;
    if (sample.intervalMs <= 0 || sample.rest) return;
    const atFloor = next.pointBudget <= next.minBudget;
    const tooSlow = next.avgCostMs > next.targetIntervalMs * 0.95 || (next.missedRate > 0.3 && gpuLoaded(next));
    this.starvedFrames = atFloor && tooSlow ? this.starvedFrames + 1 : 0;
  }

  /**
   * Le budget est à son plancher et les images restent nettement trop
   * lentes : moins de points ne peut plus aider, ce sont les réglages de
   * rendu qui doivent coûter moins.
   */
  isStarved(): boolean {
    return this.starvedFrames >= STARVED_FRAMES;
  }

  /** Relance les mesures après un changement des réglages de rendu. */
  resetMeasurements(): void {
    this.starvedFrames = 0;
    this.state = {
      ...this.state,
      framesSeen: 0,
      missedRate: 0,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES,
    };
  }

  /** Points que le LOD peut dessiner à cette image. */
  get pointBudget(): number {
    return Math.max(1, Math.floor(this.state.pointBudget * this.userScale));
  }

  get rawBudget(): number {
    return this.state.pointBudget;
  }

  /** Vue en lecture seule du contrôleur (statistiques, benchs). */
  getState(): Readonly<LodBudgetState> {
    return this.state;
  }

  /** Le coût et la cadence laissent une nette marge et le plafond n'est pas atteint : le budget croîtrait. */
  canGrow(): boolean {
    return this.state.pointBudget < this.state.ceiling && isFast(this.state);
  }

  /**
   * Aucun changement récent et aucune croissance en attente. La boucle de
   * rendu continue de dessiner tant que c'est faux, sinon une caméra immobile
   * figerait le budget (la croissance demande une série d'images rapides mesurées).
   */
  isSettled(): boolean {
    return this.framesSinceChange >= SETTLED_FRAMES && !this.canGrow();
  }
}
