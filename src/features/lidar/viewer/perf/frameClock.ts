// ============================================
// Cadence réelle des images du viewer (intervalles rAF)
// ============================================
//
// Les horodatages GPU ne mesurent que les passes d'une image. Ce que voit
// l'utilisateur dépend aussi de la vsync, du compositeur et du thread
// principal : sur un écran 60 Hz, une image de 17 ms de travail GPU rate une
// vsync sur deux et le viewer tourne à 30 i/s. Cette horloge mesure
// l'intervalle entre images rendues consécutives tant que le viewer rend en
// continu, et estime la période de rafraîchissement de l'écran à partir des plus courts.

/** Fréquences de rafraîchissement (Hz) sur lesquelles s'aligne l'estimation de période. */
const COMMON_REFRESH_HZ = [60, 75, 90, 100, 120, 144, 165, 180, 240];
const SNAP_TOLERANCE = 0.08;
/** Intervalles de la fenêtre de cadence (≈ 1 s à 60 Hz). */
const WINDOW = 60;
/** Intervalles gardés pour l'estimation du rafraîchissement. */
const HISTORY = 300;
const REFRESH_MIN_SAMPLES = 30;
/** Écran le plus lent supposé : un GPU qui n'atteint jamais la vsync ne doit pas passer pour un écran 30 Hz. */
const MAX_REFRESH_MS = 1000 / 60;
const MIN_REFRESH_MS = 1000 / 240;
/** Intervalle d'image le plus court visé (≈ 90 i/s) : les écrans plus rapides reçoivent un multiple de leur période. */
const MIN_TARGET_INTERVAL_MS = 11;
/** Un intervalle plus long que ce multiple de la période de rafraîchissement a raté au moins une vsync. */
const MISSED_FACTOR = 1.5;
/** Les écarts plus longs sont des pauses (changement d'onglet, débogueur, tâche longue), pas des images. */
const MAX_INTERVAL_MS = 1000;

export interface FrameCadence {
  /** Images par seconde sur la fenêtre récente (0 avant deux images continues). */
  fps: number;
  p50Ms: number;
  p95Ms: number;
  /** Part des intervalles récents qui ont raté au moins une vsync. */
  missedRatio: number;
  samples: number;
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index]!;
}

/** Aligne une période mesurée sur une fréquence de rafraîchissement courante quand elle en est proche. */
function snapRefreshPeriod(ms: number): number {
  for (const hz of COMMON_REFRESH_HZ) {
    const period = 1000 / hz;
    if (Math.abs(ms - period) <= period * SNAP_TOLERANCE) return period;
  }
  return ms;
}

/** Plus petit multiple de la période de rafraîchissement d'au moins `MIN_TARGET_INTERVAL_MS`. */
function targetIntervalFor(refreshMs: number): number {
  return refreshMs * Math.max(1, Math.ceil(MIN_TARGET_INTERVAL_MS / refreshMs - 1e-6));
}

export class FrameClock {
  private lastTime = -1;
  private readonly window = new Float64Array(WINDOW);
  private windowCount = 0;
  private windowNext = 0;
  private readonly history = new Float64Array(HISTORY);
  private historyCount = 0;
  private historyNext = 0;
  private sinceRefreshUpdate = 0;
  private refreshMs = MAX_REFRESH_MS;
  private cadence: FrameCadence | null = null;
  /**
   * Intervalle avant la dernière image de la série, longs compris (0 pour la
   * première image). Dans une série continue, un long écart est une image
   * lente, pas une pause : le coût des images fixes quand le GPU n'est pas chronométré.
   */
  lastIntervalMs = 0;

  /**
   * Une image est rendue au temps rAF `now` (ms). Renvoie l'intervalle depuis
   * la précédente, ou 0 pour la première image d'une série.
   */
  frame(now: number): number {
    let interval = 0;
    this.lastIntervalMs = 0;
    if (this.lastTime >= 0) {
      interval = now - this.lastTime;
      this.lastIntervalMs = Math.max(0, interval);
      if (interval > 0 && interval < MAX_INTERVAL_MS) this.push(interval);
      else interval = 0;
    }
    this.lastTime = now;
    return interval;
  }

  /** Le rendu s'est arrêté (repos, onglet masqué) : l'image suivante commence une nouvelle série. */
  pause(): void {
    this.lastTime = -1;
  }

  /** Période de rafraîchissement estimée de l'écran (ms), 60 Hz tant que non mesurée. */
  getRefreshMs(): number {
    return this.refreshMs;
  }

  /** Intervalle d'image visé par le viewer : 60 i/s sur 60/120 Hz, 72 i/s sur 144 Hz… */
  getTargetIntervalMs(): number {
    return targetIntervalFor(this.refreshMs);
  }

  /** Cadence des dernières images continues (gardée pendant que le viewer est au repos). */
  getCadence(): FrameCadence {
    if (this.cadence) return this.cadence;
    const count = this.windowCount;
    const sorted = this.window.slice(0, count).sort();
    let sum = 0;
    let missed = 0;
    for (let i = 0; i < count; i++) {
      sum += sorted[i]!;
      if (sorted[i]! > this.refreshMs * MISSED_FACTOR) missed++;
    }
    this.cadence = {
      fps: count > 0 ? Math.round((1000 * count) / sum) : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      missedRatio: count > 0 ? missed / count : 0,
      samples: count,
    };
    return this.cadence;
  }

  private push(interval: number): void {
    this.window[this.windowNext] = interval;
    this.windowNext = (this.windowNext + 1) % WINDOW;
    this.windowCount = Math.min(WINDOW, this.windowCount + 1);
    this.history[this.historyNext] = interval;
    this.historyNext = (this.historyNext + 1) % HISTORY;
    this.historyCount = Math.min(HISTORY, this.historyCount + 1);
    this.cadence = null;
    if (++this.sinceRefreshUpdate >= REFRESH_MIN_SAMPLES && this.historyCount >= REFRESH_MIN_SAMPLES) {
      this.sinceRefreshUpdate = 0;
      // Les images qui ont tenu la vsync sont les plus courtes : un percentile bas
      // ignore un rappel précoce isolé mais pas une série de vsyncs ratées.
      const sorted = this.history.slice(0, this.historyCount).sort();
      const estimate = snapRefreshPeriod(percentile(sorted, 0.1));
      this.refreshMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, estimate));
    }
  }
}
