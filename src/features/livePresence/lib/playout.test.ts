import { describe, expect, it } from 'vitest';

import { MAX_PLAYOUT_DELAY_MS, normalizeAngle, PlayoutClock, SampleTrack } from './playout';

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Delivery {
  t: number;
  arrival: number;
  value: number;
}

/**
 * Émetteur à 30 Hz (horloge de l'émetteur décalée de `clockSkew`), réseau
 * avec latence `base` + gigue uniforme et pertes ; ordre conservé (TCP).
 */
function stream(options: { durationMs: number; base: number; jitter: number; loss: number; seed: number; value: (t: number) => number; clockSkew?: number }): Delivery[] {
  const rand = random(options.seed);
  const out: Delivery[] = [];
  let lastArrival = 0;
  for (let t = 0; t <= options.durationMs; t += 1000 / 30) {
    if (rand() < options.loss) continue;
    const arrival = Math.max(lastArrival, t + options.base + rand() * options.jitter);
    lastArrival = arrival;
    out.push({ t: t + (options.clockSkew ?? 0), arrival, value: options.value(t) });
  }
  return out;
}

/** Lecture image par image à `fps` : temps joué, valeur, et si le flux était à court. */
function play(deliveries: Delivery[], fps: number, untilMs: number) {
  const clock = new PlayoutClock();
  const track = new SampleTrack();
  const frames: Array<{ now: number; time: number | null; value: number | null; settled: boolean }> = [];
  let next = 0;
  for (let now = 0; now <= untilMs; now += 1000 / fps) {
    while (next < deliveries.length && deliveries[next].arrival <= now) {
      const { t, arrival, value } = deliveries[next];
      clock.observe(t, arrival);
      track.push({ t, values: [value] });
      next += 1;
    }
    const time = clock.playbackTime(now);
    const sample = track.sample(time);
    frames.push({ now, time, value: sample?.values?.[0] ?? null, settled: sample?.settled ?? true });
  }
  return frames;
}

describe('lecture en différé : horloge', () => {
  it('le temps joué ne recule jamais ; il avance au rythme réel, ± un rattrapage borné', () => {
    const deliveries = stream({ durationMs: 10_000, base: 60, jitter: 40, loss: 0.02, seed: 1, value: (t) => t, clockSkew: 123_456 });
    const frames = play(deliveries, 60, 10_000).filter((frame) => frame.time !== null);
    let nominal = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const advance = frames[index].time! - frames[index - 1].time!;
      const real = frames[index].now - frames[index - 1].now;
      expect(advance).toBeGreaterThanOrEqual(0);
      expect(advance).toBeLessThanOrEqual(real * 1.25 + 1e-9);
      if (Math.abs(advance - real) <= real * 0.05 + 1e-9) nominal += 1;
    }
    // Presque toujours au rythme réel (à ± 5 %).
    expect(nominal / frames.length).toBeGreaterThan(0.95);
  });

  it('réseau bloqué : la lecture s’arrête au dernier échantillon puis rattrape, sans saut', () => {
    const clock = new PlayoutClock();
    const track = new SampleTrack();
    // 30 Hz, 50 ms de latence ; tout ce qui part entre 1 000 et 1 400 ms arrive d'un coup à 1 450 ms.
    const deliveries: Delivery[] = [];
    for (let t = 0; t <= 4_000; t += 1000 / 30) {
      deliveries.push({ t, arrival: t >= 1_000 && t < 1_400 ? 1_450 : t + 50, value: t });
    }
    let next = 0;
    let previous: number | null = null;
    let maxStep = 0;
    for (let now = 0; now <= 6_000; now += 1000 / 60) {
      while (next < deliveries.length && deliveries[next].arrival <= now) {
        clock.observe(deliveries[next].t, deliveries[next].arrival);
        track.push({ t: deliveries[next].t, values: [deliveries[next].value] });
        next += 1;
      }
      const value = track.sample(clock.playbackTime(now))?.values?.[0] ?? null;
      if (value !== null && previous !== null) maxStep = Math.max(maxStep, value - previous);
      if (value !== null) previous = value;
    }
    // Valeur = temps de l'émetteur : un pas d'image vaut 16,7 ms au rythme réel, 20,8 ms au plus en rattrapage.
    expect(maxStep).toBeLessThanOrEqual((1000 / 60) * 1.25 + 1e-6);
    expect(previous).toBe(deliveries[deliveries.length - 1].value);
  });

  it('retard total (échantillon émis → affiché) : latence réseau + ≈ un intervalle + gigue', () => {
    const deliveries = stream({ durationMs: 10_000, base: 50, jitter: 30, loss: 0, seed: 2, value: (t) => t, clockSkew: -9_999 });
    const frames = play(deliveries, 60, 10_000).filter((frame) => frame.now > 2_000);
    const lags = frames.map((frame) => frame.now - (frame.time! + 9_999));
    const p95 = [...lags].sort((a, b) => a - b)[Math.floor(lags.length * 0.95)];
    expect(p95).toBeLessThan(150);
    expect(Math.min(...lags)).toBeGreaterThan(50);
    // Presque jamais à court d'échantillon (le délai absorbe la gigue).
    const starved = frames.filter((frame) => frame.settled).length / frames.length;
    expect(starved).toBeLessThan(0.03);
  });

  it('gigue forte : délai plus long mais borné', () => {
    const clock = new PlayoutClock();
    const rand = random(3);
    for (let t = 0; t < 5_000; t += 33) clock.observe(t, t + 40 + rand() * 400);
    expect(clock.targetDelay()).toBe(MAX_PLAYOUT_DELAY_MS);
  });

  it('horloge de l’émetteur qui recule (onglet rechargé) : repart de zéro', () => {
    const clock = new PlayoutClock();
    clock.observe(100_000, 1_000);
    clock.observe(100_033, 1_040);
    clock.observe(50, 1_100);
    const time = clock.playbackTime(1_100)!;
    expect(time).toBeLessThan(50);
    expect(time).toBeGreaterThan(50 - MAX_PLAYOUT_DELAY_MS);
  });
});

describe('lecture en différé : interpolation', () => {
  it('mouvement uniforme rejoué exactement, même avec gigue et pertes', () => {
    const speed = 0.37;
    const deliveries = stream({ durationMs: 6_000, base: 40, jitter: 50, loss: 0.03, seed: 4, value: (t) => t * speed });
    const frames = play(deliveries, 144, 6_000).filter((frame) => frame.time !== null && !frame.settled && frame.time > 100);
    expect(frames.length).toBeGreaterThan(500);
    for (const frame of frames) expect(frame.value!).toBeCloseTo(frame.time! * speed, 6);
  });

  it('arrêt : la dernière valeur exacte, puis au repos', () => {
    const deliveries = stream({ durationMs: 3_000, base: 40, jitter: 20, loss: 0, seed: 5, value: (t) => Math.min(t, 1_500) * 0.01 });
    const frames = play(deliveries, 60, 4_000);
    const last = frames[frames.length - 1];
    expect(last.settled).toBe(true);
    expect(last.value).toBe(15);
  });

  it('Hermite monotone : jamais au-delà des valeurs reçues', () => {
    const track = new SampleTrack();
    const values = [0, 0, 0, 10, 10, 10, 2, 2, 9, 9];
    values.forEach((value, index) => track.push({ t: index * 33, values: [value] }));
    for (let time = 0; time <= 9 * 33; time += 1) {
      const index = Math.min(values.length - 2, Math.floor(time / 33));
      const low = Math.min(values[index], values[index + 1]);
      const high = Math.max(values[index], values[index + 1]);
      const value = track.sample(time)!.values![0];
      expect(value).toBeGreaterThanOrEqual(low - 1e-9);
      expect(value).toBeLessThanOrEqual(high + 1e-9);
    }
  });

  it('cap déroulé au plus court : 170° → −170° passe par 180°, pas par 0°', () => {
    const track = new SampleTrack({ wrap: [0] });
    track.push({ t: 0, values: [170] });
    track.push({ t: 100, values: [-170] });
    const middle = track.sample(50)!.values![0];
    expect(Math.abs(normalizeAngle(middle))).toBeGreaterThan(170);
    expect(track.sample(200)!.values![0]).toBeCloseTo(-170, 9);
  });

  it('reprise après un repos : pas de dérive étalée sur le silence', () => {
    const track = new SampleTrack();
    for (let t = 0; t <= 300; t += 33) track.push({ t, values: [t] });
    // L'émetteur s'arrête à 297 : image clé de repos (même état) 250 ms après, puis ça repart à 2 000 ms.
    track.push({ t: 547, values: [297] });
    expect(track.isSettled()).toBe(true);
    track.push({ t: 2_000, values: [400] });
    expect(track.sample(1_500)!.values![0]).toBeCloseTo(297, 9);
    expect(track.sample(1_940)!.values![0]).toBeCloseTo(297, 6);
  });

  it('silence en plein mouvement (onglet de l’émetteur ralenti) : interpolé, pas de saut', () => {
    const track = new SampleTrack();
    for (let t = 0; t <= 300; t += 33) track.push({ t, values: [t] });
    expect(track.isSettled()).toBe(false);
    // 400 ms sans message, puis la suite : la valeur progresse à travers le trou.
    track.push({ t: 697, values: [697] });
    expect(track.sample(500)!.values![0]).toBeCloseTo(500, 6);
  });

  it('le temps joué ne recule jamais, même quand le délai visé augmente d’un coup', () => {
    const clock = new PlayoutClock();
    let previous = -Infinity;
    let now = 0;
    // Émetteur posé, puis gigue soudaine (le délai visé monte), puis reprise après un repos.
    for (let t = 0; t < 2_000; t += 33) {
      now = t + 40 + (t > 1_000 ? 250 : 0);
      clock.observe(t, now, true);
      const time = clock.playbackTime(now)!;
      expect(time).toBeGreaterThanOrEqual(previous);
      previous = time;
    }
    clock.observe(5_000, now + 3_000, true);
    const time = clock.playbackTime(now + 3_000)!;
    expect(time).toBeGreaterThanOrEqual(previous);
  });

  it('absent (pointeur hors de la carte) ou autre identité : pas d’interpolation à travers', () => {
    const track = new SampleTrack();
    track.push({ t: 0, values: [0, 0] });
    track.push({ t: 33, values: null });
    track.push({ t: 66, values: [10, 10] });
    expect(track.sample(20)!.values).toEqual([0, 0]);
    expect(track.sample(50)!.values).toBeNull();
    const chart = new SampleTrack();
    chart.push({ t: 0, values: [100], key: 'it-1' });
    chart.push({ t: 33, values: [5_000], key: 'it-2' });
    expect(chart.sample(20)).toMatchObject({ values: [100], key: 'it-1' });
    expect(chart.sample(40)).toMatchObject({ values: [5_000], key: 'it-2', settled: true });
  });

  it('sans horloge (état donné à l’arrivée) : on tient le dernier', () => {
    const track = new SampleTrack<{ w: number }>();
    track.resetTo({ t: 123, values: [1, 2], payload: { w: 1600 } });
    expect(track.sample(null)).toEqual({ values: [1, 2], key: undefined, payload: { w: 1600 }, settled: true });
  });

  it('personne ne lit (onglet en arrière-plan) : la liste reste bornée', () => {
    const track = new SampleTrack();
    for (let t = 0; t < 60_000; t += 33) track.push({ t, values: [t] });
    expect(track.size).toBeLessThan(100);
  });
});
