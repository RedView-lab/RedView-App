/**
 * Minuteurs du cycle de vie de la carte qui ne comptent que le temps où la page
 * est visible.
 *
 * Une page masquée (onglet en arrière-plan, fenêtre réduite ou entièrement
 * recouverte) ne reçoit aucune image d'animation : Mapbox n'analyse pas de
 * style (`Style#loadJSON` attend une image), ne demande aucune tuile et
 * n'atteint jamais l'inactivité. Un chien de garde en temps réel voyait alors
 * une carte « bloquée » et lançait ses récupérations sur une carte simplement
 * pas dessinée — `setStyle` forcé depuis l'URL, reconstructions de la source
 * DEM, rechargements du terrain, un faux « Carte prête » à 12 s. Chaque chien de
 * garde qui juge la progression de Mapbox tourne plutôt sur cette horloge :
 * elle se met en pause quand la page est masquée et reprend avec le temps qui
 * lui restait dès que la page réapparaît.
 */
export interface VisibleTimer {
  readonly visibleTimer: true;
}

interface TimerEntry extends VisibleTimer {
  fn: () => void;
  /** Millisecondes visibles restantes avant la prochaine exécution. */
  remaining: number;
  /** Période d'un intervalle, null pour un minuteur à usage unique. */
  period: number | null;
  startedAt: number;
  native: ReturnType<typeof setTimeout> | null;
}

const entries = new Set<TimerEntry>();
let listening = false;

const isPageHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

function run(entry: TimerEntry): void {
  entry.startedAt = performance.now();
  entry.native = setTimeout(() => fire(entry), entry.remaining);
}

function pause(entry: TimerEntry): void {
  if (!entry.native) return;
  clearTimeout(entry.native);
  entry.native = null;
  entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
}

function fire(entry: TimerEntry): void {
  entry.native = null;
  if (!entries.has(entry)) return;
  if (isPageHidden()) {
    // Déclenché entre le masquage de la page et son événement visibilitychange.
    entry.remaining = 0;
    return;
  }
  if (entry.period === null) {
    entries.delete(entry);
  } else {
    entry.remaining = entry.period;
    run(entry);
  }
  entry.fn();
}

function onVisibilityChange(): void {
  const hidden = isPageHidden();
  for (const entry of entries) {
    if (hidden) pause(entry);
    else if (!entry.native) run(entry);
  }
}

function track(fn: () => void, delayMs: number, period: number | null): VisibleTimer {
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    listening = true;
  }
  const entry: TimerEntry = {
    visibleTimer: true,
    fn,
    remaining: Math.max(0, delayMs),
    period,
    startedAt: 0,
    native: null,
  };
  entries.add(entry);
  if (!isPageHidden()) run(entry);
  return entry;
}

/** `setTimeout` qui ne compte que le temps visible. */
export function setVisibleTimeout(fn: () => void, delayMs: number): VisibleTimer {
  return track(fn, delayMs, null);
}

/** `setInterval` qui ne compte que le temps visible. */
export function setVisibleInterval(fn: () => void, periodMs: number): VisibleTimer {
  return track(fn, periodMs, Math.max(1, periodMs));
}

export function clearVisibleTimer(timer: VisibleTimer | null | undefined): void {
  if (!timer) return;
  const entry = timer as TimerEntry;
  if (!entries.delete(entry)) return;
  if (entry.native) clearTimeout(entry.native);
  entry.native = null;
}
