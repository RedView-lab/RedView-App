import { ARRIVAL_BRAKING_S, SPEED_SPRING_HALF_LIFE_S } from '../config';
import { smoothstep, smoothstepIntegral, smootherstep, stepCriticalSpring, type SpringState } from './springs';

/**
 * Horloge de lecture. Avance un temps de lecture « à 1× » (τ) :
 * dτ/dt = porte × multiplicateur.
 *  - porte : 0 → 1 au départ / à la reprise, 1 → 0 à la pause (smootherstep :
 *    accélération nulle aux deux bouts) ;
 *  - multiplicateur : ressort critiquement amorti vers le palier choisi ;
 *  - arrivée : freinage en « 1 − smoothstep » déclenché pile quand le reste
 *    égale la distance de freinage, intégré en forme close : la tête s'arrête
 *    exactement sur la fin, sans à-coup.
 * Intégration trapèze sur des fonctions lisses : quasi indépendante du framerate.
 */
export class PlaybackTransport {
  private time = 0;
  private end: number;
  private gate = 0;
  private gateFrom = 0;
  private gateTo = 0;
  private gateElapsed = 0;
  private gateDuration = 0;
  private readonly multiplier: SpringState;
  private multiplierTarget: number;
  private brake: { startTime: number; rate: number; duration: number; elapsed: number } | null = null;
  private arrivedFlag = false;

  constructor(endTime: number, multiplier: number) {
    this.end = Math.max(0, endTime);
    this.multiplier = { value: multiplier, velocity: 0 };
    this.multiplierTarget = multiplier;
  }

  get playbackTime(): number {
    return this.time;
  }

  get endTime(): number {
    return this.end;
  }

  get arrived(): boolean {
    return this.arrivedFlag;
  }

  /** Arrêté : porte nulle et pas de reprise en cours. */
  get stopped(): boolean {
    return this.brake == null && this.gate <= 0 && this.gateTo <= 0;
  }

  get multiplierValue(): number {
    return this.multiplier.value;
  }

  /** Vitesse de l'horloge (s de lecture à 1× par seconde réelle). */
  get rate(): number {
    if (this.brake) {
      const x = this.brake.elapsed / this.brake.duration;
      return this.brake.rate * (1 - smoothstep(x));
    }
    return this.gate * this.multiplier.value;
  }

  seek(time: number): void {
    this.time = Math.max(0, Math.min(this.end, time));
    this.brake = null;
    this.arrivedFlag = this.time >= this.end;
  }

  /** Lance (ou relance) l'avance, porte montée en `easeS`. */
  start(easeS: number): void {
    if (this.arrivedFlag) return;
    this.rampGate(1, easeS);
  }

  /** Décélère jusqu'à l'arrêt en `easeS`. */
  stop(easeS: number): void {
    if (this.brake) {
      // Reprend la vitesse courante du freinage dans la porte : pas de saut.
      this.gate = Math.min(1, this.rate / Math.max(1e-6, this.multiplier.value));
      this.brake = null;
    }
    this.rampGate(0, easeS);
  }

  /** Arrêt immédiat (seek, sortie). */
  halt(): void {
    this.brake = null;
    this.gate = 0;
    this.gateFrom = 0;
    this.gateTo = 0;
    this.gateElapsed = 0;
    this.gateDuration = 0;
  }

  setMultiplier(multiplier: number): void {
    this.multiplierTarget = multiplier;
  }

  step(dt: number): void {
    if (dt <= 0) return;
    if (this.brake) {
      this.stepBrake(dt);
      return;
    }
    const rateBefore = this.gate * this.multiplier.value;
    stepCriticalSpring(this.multiplier, this.multiplierTarget, SPEED_SPRING_HALF_LIFE_S, dt);
    if (this.gateDuration > 0 && this.gateElapsed < this.gateDuration) {
      this.gateElapsed = Math.min(this.gateDuration, this.gateElapsed + dt);
      this.gate = this.gateFrom + (this.gateTo - this.gateFrom) * smootherstep(this.gateElapsed / this.gateDuration);
    } else {
      this.gate = this.gateTo;
    }
    const rateAfter = this.gate * this.multiplier.value;
    this.time = Math.min(this.end, this.time + (dt * (rateBefore + rateAfter)) / 2);

    if (this.gateTo <= 0 || rateAfter <= 0) return;
    const remaining = this.end - this.time;
    if (remaining <= 1e-9) {
      this.finish();
      return;
    }
    // Freinage « 1 − smoothstep » de durée T : parcourt rate·T/2. On le
    // déclenche quand le reste vaut la distance de freinage nominale.
    if (remaining <= (rateAfter * ARRIVAL_BRAKING_S) / 2) {
      this.brake = { startTime: this.time, rate: rateAfter, duration: (2 * remaining) / rateAfter, elapsed: 0 };
    }
  }

  private stepBrake(dt: number): void {
    const brake = this.brake as NonNullable<typeof this.brake>;
    stepCriticalSpring(this.multiplier, this.multiplierTarget, SPEED_SPRING_HALF_LIFE_S, dt);
    brake.elapsed += dt;
    const x = brake.elapsed / brake.duration;
    if (x >= 1) {
      this.finish();
      return;
    }
    // ∫₀ˣ (1 − smoothstep) = x − ∫₀ˣ smoothstep
    this.time = brake.startTime + brake.rate * brake.duration * (x - smoothstepIntegral(x));
  }

  private finish(): void {
    this.time = this.end;
    this.brake = null;
    this.gate = 0;
    this.gateFrom = 0;
    this.gateTo = 0;
    this.arrivedFlag = true;
  }

  private rampGate(to: number, durationS: number): void {
    this.gateFrom = this.gate;
    this.gateTo = to;
    this.gateElapsed = 0;
    this.gateDuration = Math.max(0, durationS);
    if (this.gateDuration === 0) this.gate = to;
  }
}
