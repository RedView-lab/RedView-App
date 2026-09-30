// ─────────────────────────────────────────────────────────────────────
// Tri automatique des POI — sélection
// ─────────────────────────────────────────────────────────────────────
//
// Balayage unique vers l'avant sur deux « besoins » : l'eau et le
// ravitaillement. À chaque tour, chaque besoin propose son meilleur
// candidat dans sa fenêtre et on retient le plus tôt des deux : les arrêts
// sont posés dans l'ordre chronologique, si bien qu'un ravito ouvert
// recharge aussi l'eau avant que l'on cherche la fontaine suivante.
// L'heure de passage est recalculée à la volée : chaque favori retenu
// ajoute sa pause (si les favoris marquent une pause) et décale donc tout
// ce qui suit. Viennent ensuite deux passes : hôtels (nuit) et règle des 6h.

import type { PoiFeature } from '../../types';
import type { Candidate } from './enrich';
import { evaluateOpeningHoursAt } from './openingHours';
import { AUTO_SORT_TYPICAL_HOURS, type AutoSortRules, type ClockWindow } from './rules';
import type {
  AutoSortPick,
  AutoSortReason,
  AutoSortTimeModel,
  AutoSortWarning,
  OpenStatus,
} from './types';

const HOUR_S = 3600;
const DAY_MIN = 24 * 60;

type Channel = 'water' | 'food';

interface Timed {
  candidate: Candidate;
  rideS: number;
}

interface Evaluated {
  timed: Timed;
  scheduledS: number;
  clockMin: number;
  status: OpenStatus;
  /** Ouvert, ou horaires inconnus mais passage dans les horaires habituels. */
  likelyOpen: boolean;
  /** Multiplicateur de score lié à l'ouverture (0 = fermé à coup sûr). */
  openFactor: number;
}

/** Horloge « pauses comprises » : pauses existantes + pauses des favoris retenus. */
class Schedule {
  private readonly pickPauses: Array<{ rideS: number; pauseS: number }> = [];
  private readonly baseAnchors: AutoSortTimeModel['baseStopAnchors'];
  private readonly startMinuteOfDay: number;
  private readonly start: Date;

  constructor(time: AutoSortTimeModel) {
    this.start = time.start;
    this.baseAnchors = [...time.baseStopAnchors].sort(
      (l, r) => l.rideElapsedSeconds - r.rideElapsedSeconds,
    );
    this.startMinuteOfDay = time.start.getHours() * 60 + time.start.getMinutes() + time.start.getSeconds() / 60;
  }

  scheduledAt(rideS: number): number {
    let scheduled = rideS;
    for (const anchor of this.baseAnchors) {
      if (rideS <= anchor.rideElapsedSeconds + 0.05) break;
      scheduled += anchor.durationMin * 60;
    }
    for (const pause of this.pickPauses) {
      if (pause.rideS < rideS - 0.05) scheduled += pause.pauseS;
    }
    return scheduled;
  }

  addPause(rideS: number, pauseS: number): void {
    if (pauseS > 0) this.pickPauses.push({ rideS, pauseS });
  }

  /** Minutes depuis minuit du jour de départ (dépasse 1440 les jours suivants). */
  clockMin(scheduledS: number): number {
    return this.startMinuteOfDay + scheduledS / 60;
  }

  /** Secondes depuis le départ pour une heure d'horloge absolue. */
  scheduledForClock(clockMin: number): number {
    return (clockMin - this.startMinuteOfDay) * 60;
  }

  arrival(scheduledS: number): Date {
    return new Date(this.start.getTime() + scheduledS * 1000);
  }
}

export function inClockWindow(clockMin: number, window: ClockWindow): boolean {
  const m = ((clockMin % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return (m >= window.startMin && m < window.endMin)
    || (m + DAY_MIN >= window.startMin && m + DAY_MIN < window.endMin);
}

/** Occurrences absolues (minutes d'horloge) d'une plage quotidienne recoupant [fromMin, toMin]. */
function windowOccurrences(window: ClockWindow, fromMin: number, toMin: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let day = Math.floor(fromMin / DAY_MIN) - 1; day <= Math.floor(toMin / DAY_MIN); day++) {
    const start = day * DAY_MIN + window.startMin;
    const end = day * DAY_MIN + window.endMin;
    if (end > fromMin && start < toMin) out.push([start, end]);
  }
  return out;
}

function bestOf<T>(pool: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of pool) {
    const s = score(item);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

export interface SelectionOutput {
  picks: AutoSortPick[];
  warnings: AutoSortWarning[];
  hotelsPerNight: number[];
}

interface SelectionContext {
  timed: readonly Timed[];
  schedule: Schedule;
  rules: AutoSortRules;
  endRideS: number;
  available: (t: Timed) => boolean;
  evaluate: (t: Timed) => Evaluated;
  commit: (e: Evaluated, reason: AutoSortReason) => AutoSortPick;
  foodScore: (e: Evaluated, targetS?: number) => number;
  picks: readonly AutoSortPick[];
}

const isFood = (c: Candidate) => c.kind === 'shop' || c.kind === 'meal' || c.kind === 'night';

export function selectAutoSortPicks(
  candidates: readonly Candidate[],
  time: AutoSortTimeModel,
  rules: AutoSortRules,
  manualIds: ReadonlySet<string | number>,
  routeTotalM: number,
): SelectionOutput {
  const schedule = new Schedule(time);
  const timed: Timed[] = candidates
    .map((candidate) => ({ candidate, rideS: time.rideSecondsAt(candidate.progressM) }))
    .filter((t) => Number.isFinite(t.rideS))
    .sort((l, r) => l.rideS - r.rideS);
  const endRideS = time.rideSecondsAt(routeTotalM);

  const isManual = (feature: PoiFeature) => manualIds.has(feature.id) || manualIds.has(String(feature.id));
  const taken = new Set<string | number>();
  const picks: AutoSortPick[] = [];
  const warnings: AutoSortWarning[] = [];

  const evaluate = (t: Timed): Evaluated => {
    const c = t.candidate;
    const scheduledS = schedule.scheduledAt(t.rideS);
    const clockMin = schedule.clockMin(scheduledS);
    if (c.kind === 'water') {
      return { timed: t, scheduledS, clockMin, status: 'open', likelyOpen: true, openFactor: 1 };
    }
    const status = evaluateOpeningHoursAt(
      c.feature.tags?.opening_hours,
      schedule.arrival(scheduledS),
      rules.opening.closingMarginMin,
      time.hasRealDate,
    );
    if (status === 'open') return { timed: t, scheduledS, clockMin, status, likelyOpen: true, openFactor: 1 };
    if (status === 'closed') {
      const openFactor = c.kind === 'hotel' ? rules.opening.hotelClosedFactor : 0;
      return { timed: t, scheduledS, clockMin, status, likelyOpen: false, openFactor };
    }
    const typical = AUTO_SORT_TYPICAL_HOURS[c.feature.category];
    const likelyOpen = !typical || typical.some((window) => inClockWindow(clockMin, window));
    return {
      timed: t,
      scheduledS,
      clockMin,
      status,
      likelyOpen,
      openFactor: likelyOpen ? rules.opening.unknownLikelyOpenFactor : rules.opening.unknownLikelyClosedFactor,
    };
  };

  const commit = (e: Evaluated, reason: AutoSortReason): AutoSortPick => {
    const c = e.timed.candidate;
    taken.add(c.feature.id);
    schedule.addPause(e.timed.rideS, time.pauseMinutesFor(c.feature) * 60);
    const pick: AutoSortPick = {
      feature: c.feature,
      reason,
      kind: c.kind,
      progressM: c.progressM,
      lateralM: c.lateralM,
      side: c.side,
      gradePct: c.gradePct,
      rideSeconds: e.timed.rideS,
      scheduledSeconds: e.scheduledS,
      arrival: schedule.arrival(e.scheduledS),
      openStatus: e.status,
      likelyOpen: e.likelyOpen,
      fallback: c.fallback,
    };
    picks.push(pick);
    return pick;
  };

  const available = (t: Timed) => !taken.has(t.candidate.feature.id) && !isManual(t.candidate.feature);
  const manualStops = timed.filter((t) => isManual(t.candidate.feature) && t.candidate.kind !== 'hotel');

  const timeOfDayFactor = (c: Candidate, clockMin: number): number => {
    const tod = rules.timeOfDay;
    let factor = 1;
    if (inClockWindow(clockMin, tod.bakeryMorning) && c.feature.category === 'bakery') {
      factor *= tod.bakeryMorning.boost;
    }
    if (inClockWindow(clockMin, tod.lunch)) factor *= tod.lunch.boost;
    if (inClockWindow(clockMin, tod.evening)) factor *= tod.evening.boost;
    if (inClockWindow(clockMin, tod.deepNight)) {
      if (c.kind === 'night') factor *= tod.deepNight.nightKindBoost;
      if (c.is247) factor *= tod.deepNight.open247Boost;
    }
    return factor;
  };

  const foodScore = (e: Evaluated, targetS?: number): number => {
    const c = e.timed.candidate;
    const position = targetS == null ? 1 : Math.max(0.5, 1 - (0.25 * Math.abs(e.scheduledS - targetS)) / HOUR_S);
    return c.quality * c.clusterBonus * e.openFactor * timeOfDayFactor(c, e.clockMin) * position;
  };

  const foodReason = (e: Evaluated): AutoSortReason => {
    const tod = rules.timeOfDay;
    const c = e.timed.candidate;
    if (c.feature.category === 'bakery' && inClockWindow(e.clockMin, tod.bakeryMorning)) return 'bakery';
    if (inClockWindow(e.clockMin, tod.deepNight)) return 'night';
    if (inClockWindow(e.clockMin, tod.lunch) || inClockWindow(e.clockMin, tod.evening)) return 'meal';
    return 'resupply';
  };

  const km = (progressM: number) => Math.round(progressM / 100) / 10;

  // ── Eau ──────────────────────────────────────────────────────────
  const chooseWater = (lastS: number): Evaluated | null => {
    const lo = lastS + rules.water.minGapH * HOUR_S;
    const hi = lastS + rules.water.maxGapH * HOUR_S;
    const earliest = lastS + 0.25 * HOUR_S;
    const pool = timed
      .filter((t) => t.candidate.kind === 'water' && available(t))
      .map(evaluate)
      .filter((e) => e.scheduledS > earliest);
    const score = (e: Evaluated) => {
      const position = Math.max(0, Math.min(1, (e.scheduledS - earliest) / (hi - earliest)));
      return e.timed.candidate.quality * e.timed.candidate.clusterBonus * (0.75 + 0.25 * position);
    };
    // Fenêtre idéale, puis plus tôt, puis en acceptant descente / côté gauche.
    const attempts: Array<(e: Evaluated) => boolean> = [
      (e) => !e.timed.candidate.fallback && e.scheduledS >= lo && e.scheduledS <= hi,
      (e) => !e.timed.candidate.fallback && e.scheduledS <= hi,
      (e) => e.scheduledS <= hi,
    ];
    for (const accept of attempts) {
      const best = bestOf(pool.filter(accept), score);
      if (best) return best;
    }
    // Aucun point d'eau avant l'échéance : le premier après, en évitant si
    // possible une descente dans la demi-heure qui suit.
    const after = pool.filter((e) => e.scheduledS > hi);
    if (after.length === 0) return null;
    const first = after[0]!;
    const good = after.find((e) => !e.timed.candidate.fallback && e.scheduledS <= first.scheduledS + 0.5 * HOUR_S);
    return good ?? first;
  };

  // ── Ravitaillement ───────────────────────────────────────────────
  const foodPicks: Evaluated[] = [];
  const mealWindowCovered = (startS: number, endS: number) =>
    foodPicks.some((p) => p.scheduledS >= startS && p.scheduledS < endS)
    || manualStops.some((t) => {
      if (!isFood(t.candidate)) return false;
      const s = schedule.scheduledAt(t.rideS);
      return s >= startS && s < endS;
    });

  const chooseFood = (lastS: number): { pick: Evaluated; guaranteed: boolean } | null => {
    const minGapS = rules.resupply.minGapH * HOUR_S;
    const lo = lastS + minGapS;
    const hi = lastS + rules.resupply.maxGapH * HOUR_S;
    const target = lastS + rules.resupply.targetGapH * HOUR_S;
    const earliest = lastS + rules.resupply.mealMinGapH * HOUR_S;
    const pool = timed
      .filter((t) => isFood(t.candidate) && available(t))
      .map(evaluate)
      .filter((e) => e.scheduledS > lastS + 0.25 * HOUR_S && e.openFactor > 0);
    // Boulangerie du matin prioritaire : acceptée dès 1h après le dernier
    // arrêt, sans pénalité d'écart à l'intervalle cible.
    const morningBakery = (e: Evaluated) =>
      e.timed.candidate.feature.category === 'bakery'
      && inClockWindow(e.clockMin, rules.timeOfDay.bakeryMorning)
      && e.scheduledS >= earliest;
    const score = (e: Evaluated) => foodScore(e, morningBakery(e) ? undefined : target);

    // Un commerce probablement fermé ne sert à rien : mieux vaut un peu
    // dépasser l'échéance vers un commerce probablement ouvert.
    let normal: Evaluated | null = null;
    for (const accept of [
      (e: Evaluated) => e.likelyOpen && e.scheduledS <= hi && (e.scheduledS >= lo || morningBakery(e)),
      (e: Evaluated) => e.likelyOpen && e.scheduledS >= lastS + 0.5 * HOUR_S && e.scheduledS <= hi,
      (e: Evaluated) => e.likelyOpen && e.scheduledS > hi && e.scheduledS <= hi + rules.resupply.likelyOpenOverrunH * HOUR_S,
      (e: Evaluated) => e.scheduledS >= lastS + 0.5 * HOUR_S && e.scheduledS <= hi,
    ]) {
      normal = bestOf(pool.filter(accept), score);
      if (normal) break;
    }

    // Créneau repas garanti : on ne force un arrêt dans le créneau que si
    // l'arrêt « normal » le ferait sauter (il tombe après, ou si tôt avant
    // que l'arrêt suivant, au plus tôt 2h plus tard, tomberait après).
    for (const window of rules.timeOfDay.mealGuarantees) {
      for (const [startMin, endMin] of windowOccurrences(window, schedule.clockMin(earliest), schedule.clockMin(hi))) {
        const startS = schedule.scheduledForClock(startMin);
        const endS = schedule.scheduledForClock(endMin);
        if (mealWindowCovered(startS, endS)) continue;
        if (normal) {
          const inside = normal.scheduledS >= startS && normal.scheduledS < endS;
          const reachableLater = normal.scheduledS < startS && normal.scheduledS + minGapS < endS;
          if (inside || reachableLater) continue;
        }
        const inWindow = pool.filter(
          (e) => e.likelyOpen && e.scheduledS >= Math.max(startS, earliest) && e.scheduledS < Math.min(endS, hi),
        );
        const best = bestOf(inWindow, (e) => foodScore(e));
        if (best) return { pick: best, guaranteed: true };
      }
    }

    if (normal) return { pick: normal, guaranteed: false };
    const after = pool.filter((e) => e.scheduledS > hi);
    if (after.length === 0) return null;
    // Premier ravito après le trou, ou mieux dans la demi-heure suivante.
    const horizon = after[0]!.scheduledS + 0.5 * HOUR_S;
    return { pick: bestOf(after.filter((e) => e.scheduledS <= horizon), (e) => foodScore(e))!, guaranteed: false };
  };

  // ── Balayage ─────────────────────────────────────────────────────
  const state: Record<Channel, { last: number; lastProgressM: number; done: boolean }> = {
    water: { last: 0, lastProgressM: 0, done: false },
    food: { last: 0, lastProgressM: 0, done: false },
  };
  const advance = (channel: Channel, scheduledS: number, progressM: number) => {
    if (scheduledS <= state[channel].last) return;
    state[channel].last = scheduledS;
    state[channel].lastProgressM = progressM;
  };

  for (let guard = 0; guard < 10_000; guard++) {
    const endS = schedule.scheduledAt(endRideS);
    const deadlines: Record<Channel, number> = {
      water: state.water.last + rules.water.maxGapH * HOUR_S,
      food: state.food.last + rules.resupply.maxGapH * HOUR_S,
    };
    for (const channel of ['water', 'food'] as const) {
      if (deadlines[channel] >= endS) state[channel].done = true;
    }
    if (state.water.done && state.food.done) break;

    // Un favori manuel avant l'échéance fait office d'arrêt.
    let manualReset = false;
    for (const channel of ['water', 'food'] as const) {
      if (state[channel].done) continue;
      const manual = manualStops
        .filter((t) => channel === 'water' || isFood(t.candidate))
        .map((t) => ({ t, s: schedule.scheduledAt(t.rideS) }))
        .filter(({ s }) => s > state[channel].last + 1 && s <= deadlines[channel])
        .pop();
      if (!manual) continue;
      advance(channel, manual.s, manual.t.candidate.progressM);
      if (channel === 'food') advance('water', manual.s, manual.t.candidate.progressM);
      manualReset = true;
    }
    if (manualReset) continue;

    const water = state.water.done ? null : chooseWater(state.water.last);
    const food = state.food.done ? null : chooseFood(state.food.last);
    for (const [channel, choice] of [['water', water], ['food', food]] as const) {
      if (state[channel].done || choice) continue;
      warnings.push({
        kind: channel === 'water' ? 'waterGap' : 'resupplyGap',
        fromKm: km(state[channel].lastProgressM),
        toKm: km(routeTotalM),
        hours: (endS - state[channel].last) / HOUR_S,
      });
      state[channel].done = true;
    }
    if (!water && !food) continue;

    // Un point d'eau pris en avance (hors de sa fenêtre idéale) est inutile
    // si un ravito probablement ouvert recharge l'eau avant l'échéance.
    const waterIsEarly = water != null && water.scheduledS < state.water.last + rules.water.minGapH * HOUR_S;
    const foodCoversWater = food != null && food.pick.likelyOpen && food.pick.scheduledS <= deadlines.water;
    const takeWater = water != null
      && (food == null || water.scheduledS < food.pick.scheduledS)
      && !(waterIsEarly && foodCoversWater);
    if (takeWater) {
      if (water.scheduledS > deadlines.water) {
        warnings.push({
          kind: 'waterGap',
          fromKm: km(state.water.lastProgressM),
          toKm: km(water.timed.candidate.progressM),
          hours: (water.scheduledS - state.water.last) / HOUR_S,
        });
      }
      commit(water, 'water');
      advance('water', water.scheduledS, water.timed.candidate.progressM);
      continue;
    }

    const { pick, guaranteed } = food!;
    if (pick.scheduledS > deadlines.food) {
      warnings.push({
        kind: 'resupplyGap',
        fromKm: km(state.food.lastProgressM),
        toKm: km(pick.timed.candidate.progressM),
        hours: (pick.scheduledS - state.food.last) / HOUR_S,
      });
    }
    commit(pick, guaranteed ? 'meal' : foodReason(pick));
    foodPicks.push(pick);
    advance('food', pick.scheduledS, pick.timed.candidate.progressM);

    if (pick.likelyOpen) {
      // Un commerce ouvert fait office de recharge d'eau.
      advance('water', pick.scheduledS, pick.timed.candidate.progressM);
    } else if (pick.timed.candidate.clusterId >= 0) {
      // Ouverture incertaine : on assure l'eau au même arrêt si une
      // fontaine est à deux pas (regroupement).
      const sibling = timed.find(
        (t) => t.candidate.kind === 'water'
          && !t.candidate.fallback
          && t.candidate.clusterId === pick.timed.candidate.clusterId
          && available(t),
      );
      if (sibling && pick.scheduledS - state.water.last >= (rules.water.minGapH * HOUR_S) / 2) {
        const e = evaluate(sibling);
        commit(e, 'water');
        advance('water', e.scheduledS, sibling.candidate.progressM);
      }
    }
  }

  const context: SelectionContext = {
    timed,
    schedule,
    rules,
    endRideS,
    available,
    evaluate,
    commit,
    foodScore,
    picks,
  };
  const hotelsPerNight = selectHotels(context);
  selectDesertGuards(context);

  // Heures définitives (les pauses retenues après coup décalent les premières).
  for (const pick of picks) {
    pick.scheduledSeconds = schedule.scheduledAt(pick.rideSeconds);
    pick.arrival = schedule.arrival(pick.scheduledSeconds);
  }
  picks.sort((l, r) => l.progressM - r.progressM);
  return { picks, warnings, hotelsPerNight };
}

/**
 * Hôtels : seulement de 18h à 6h, répartis par tranches (`rules.hotel.slots`),
 * la soirée recevant le plus d'options. Dans une tranche de N options, on
 * prend le meilleur de chaque sous-tranche puis on complète avec les
 * meilleurs restants, espacés d'au moins `minSpacingMin`.
 */
function selectHotels({ timed, schedule, rules, endRideS, available, evaluate, commit }: SelectionContext): number[] {
  const window = rules.hotel.window;
  const byNight = new Map<number, Evaluated[]>();
  for (const t of timed) {
    if (t.candidate.kind !== 'hotel' || !available(t)) continue;
    const e = evaluate(t);
    if (!inClockWindow(e.clockMin, window)) continue;
    if (e.scheduledS < rules.hotel.minElapsedH * HOUR_S) continue;
    const night = Math.floor((e.clockMin - window.startMin) / DAY_MIN);
    const list = byNight.get(night) ?? [];
    list.push(e);
    byNight.set(night, list);
  }

  const endS = schedule.scheduledAt(endRideS);
  const counts: number[] = [];
  const spacingS = rules.hotel.minSpacingMin * 60;
  const score = (e: Evaluated) => e.timed.candidate.quality * e.openFactor;

  for (const [night, list] of [...byNight.entries()].sort((l, r) => l[0] - r[0])) {
    let count = 0;
    for (const slot of rules.hotel.slots) {
      // Portion de la tranche réellement parcourue (départ / arrivée en cours de nuit).
      const slotStartS = Math.max(0, schedule.scheduledForClock(night * DAY_MIN + slot.startMin));
      const slotEndS = Math.min(endS, schedule.scheduledForClock(night * DAY_MIN + slot.endMin));
      if (slotEndS <= slotStartS || slot.max <= 0) continue;
      const inSlot = list.filter((e) => e.scheduledS >= slotStartS && e.scheduledS < slotEndS);
      const chosen: Evaluated[] = [];
      const take = (e: Evaluated) => {
        commit(e, 'hotel');
        chosen.push(e);
      };
      const spacedFromChosen = (e: Evaluated) =>
        chosen.every((c) => Math.abs(c.scheduledS - e.scheduledS) >= spacingS);

      const span = slotEndS - slotStartS;
      for (let sub = 0; sub < slot.max; sub++) {
        const from = slotStartS + (span * sub) / slot.max;
        const to = slotStartS + (span * (sub + 1)) / slot.max;
        const best = bestOf(
          inSlot.filter((e) => e.scheduledS >= from && e.scheduledS < to && available(e.timed) && spacedFromChosen(e)),
          score,
        );
        if (best) take(best);
      }
      // Sous-tranches vides : on complète avec les meilleurs hôtels restants.
      while (chosen.length < slot.max) {
        const best = bestOf(inSlot.filter((e) => available(e.timed) && spacedFromChosen(e)), score);
        if (!best) break;
        take(best);
      }
      count += chosen.length;
    }
    counts.push(count);
  }
  return counts;
}

/**
 * Règle des 6h : si le prochain POI d'une même famille (fontaines,
 * boulangeries, supermarchés, restaurants…) est à plus de 6h, le dernier
 * avant ce « désert » est ajouté d'office.
 *
 * Les familles qui « désertent » au même endroit (typiquement le dernier
 * village avant une longue traversée) sont regroupées : un seul arrêt, le
 * meilleur à cette heure-là, et aucun si un arrêt du même besoin y est
 * déjà prévu.
 */
function selectDesertGuards({ timed, schedule, rules, endRideS, available, evaluate, commit, foodScore, picks }: SelectionContext): void {
  const desertS = rules.gap.desertH * HOUR_S;
  const nearS = rules.gap.preferOpenWithinMin * 60;
  const families = new Map<string, Timed[]>();
  for (const t of timed) {
    const family = t.candidate.family;
    if (!family) continue;
    const list = families.get(family) ?? [];
    list.push(t);
    families.set(family, list);
  }

  const endS = schedule.scheduledAt(endRideS);
  const proposals: Array<{ channel: Channel; options: Evaluated[]; atS: number }> = [];
  for (const members of families.values()) {
    const evaluated = members.map(evaluate);
    for (let i = 0; i < evaluated.length; i++) {
      const current = evaluated[i]!;
      const nextS = evaluated[i + 1]?.scheduledS ?? endS;
      if (nextS - current.scheduledS <= desertS) continue;
      // Candidats : les POI de la famille dans la demi-heure avant le désert.
      const options = evaluated
        .slice(0, i + 1)
        .filter((e) => e.scheduledS >= current.scheduledS - nearS);
      if (options.some((e) => !available(e.timed))) continue; // déjà favori
      proposals.push({
        channel: current.timed.candidate.kind === 'water' ? 'water' : 'food',
        options,
        atS: current.scheduledS,
      });
    }
  }

  proposals.sort((l, r) => l.atS - r.atS);
  const handled = new Set<number>();
  for (let i = 0; i < proposals.length; i++) {
    if (handled.has(i)) continue;
    const { channel, atS } = proposals[i]!;
    const group = proposals
      .map((p, index) => ({ p, index }))
      .filter(({ p, index }) => !handled.has(index) && p.channel === channel && Math.abs(p.atS - atS) <= nearS);
    for (const { index } of group) handled.add(index);

    const planned = picks.some((pick) => {
      const pickChannel: Channel = pick.kind === 'water' ? 'water' : 'food';
      return pick.kind !== 'hotel'
        && pickChannel === channel
        && Math.abs(schedule.scheduledAt(pick.rideSeconds) - atS) <= nearS;
    });
    if (planned) continue;

    const options = group.flatMap(({ p }) => p.options).filter((e) => available(e.timed));
    const best = channel === 'water'
      ? bestOf(options, (e) => e.timed.candidate.quality * (e.timed.candidate.fallback ? 0.3 : 1) + e.scheduledS / 1e9)
      : bestOf(options, (e) => foodScore(e) + 0.01 * e.timed.candidate.quality);
    if (best) commit(best, 'gap6h');
  }
}
