/**
 * RedView Test-Bench : suivre un éditeur (présence en direct, pur, sans navigateur).
 *
 * L'éditeur suivi bouge sa caméra à ≈ 60 i/s (panoramique, zoom, rotation qui
 * passe ±180°, vol de van Wijk, flyover sinueux, arrêt puis reprise) ;
 * l'émetteur échantillonne comme `PresenceBroadcaster` (front descendant à
 * 33 ms, horodatage à l'envoi, image clé 250 ms après l'arrêt) ; le réseau
 * ajoute latence + gigue (ordre conservé, comme TCP), saute 1 % des messages
 * (contre-pression) et bloque tout 300 ms une fois ; celui qui suit rejoue
 * avec le vrai code (`PlayoutClock` + `SampleTrack`, lib/playout.ts) à 30,
 * 60 et 144 i/s.
 *
 * Deux passes par scénario : réseau avec gigue et pertes (critères stricts),
 * puis le même avec un blocage de 300 ms (robustesse).
 *
 * Critères durs (code de sortie ≠ 0) :
 *  - retard (décalage qui aligne le mieux sa caméra sur la vraie) ≤ 200 ms ;
 *  - fidélité : écart résiduel après alignement ≤ 1,5 % de l'amplitude ;
 *  - aucun saut : déplacement par image ≤ 2,5 × celui de la vraie caméra au
 *    même rythme, blocage compris (la lecture s'arrête puis rattrape) ;
 *  - après un blocage (réseau, ou onglet de l'émetteur figé) : retour à la
 *    fidélité en ≤ 3 s ;
 *  - pas de ralenti de rattrapage après un arrêt (reprise ≤ retard + 80 ms) ;
 *  - jamais de retour en arrière, même quand l'onglet de l'émetteur se fige
 *    300 ms en plein mouvement (trou dans SES horodatages : interpolé) ;
 *  - position finale exacte (au repos, dernier état reçu) ;
 *  - indépendance au framerate : retard à ±30 ms entre 30, 60 et 144 i/s.
 *
 * Usage : npm run bench:follow
 */
import { PlayoutClock, SampleTrack, normalizeAngle } from '../src/features/livePresence/lib/playout.ts';

type Camera = [number, number, number, number, number]; // lng, lat, zoom, cap, inclinaison

interface Scenario {
  name: string;
  durationMs: number;
  camera(t: number): Camera;
  /** L'onglet de l'émetteur se fige (aucun envoi) pendant cet intervalle, en plein mouvement. */
  senderFreeze?: [number, number];
  /** Longitude toujours croissante : le suivi ne doit jamais reculer. */
  monotoneLng?: boolean;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const SCENARIOS: Scenario[] = [
  { name: 'panoramique', durationMs: 4_000, camera: (t) => [6.9 + 0.05 * Math.min(1, t / 4000), 45.95, 13, 0, 50], monotoneLng: true },
  {
    name: 'émetteur figé 300 ms',
    durationMs: 4_000,
    camera: (t) => [6.9 + 0.05 * Math.min(1, t / 4000), 45.95, 13, 0, 50],
    senderFreeze: [2_000, 2_300],
    monotoneLng: true,
  },
  { name: 'zoom', durationMs: 3_000, camera: (t) => [6.9, 45.95, 10 + 5 * smooth(t / 3000), 0, 50] },
  { name: 'rotation ±180°', durationMs: 3_000, camera: (t) => [6.9, 45.95, 13, normalizeAngle(150 + 60 * smooth(t / 3000)), 50] },
  {
    name: 'vol van Wijk',
    durationMs: 3_000,
    camera: (t) => {
      const s = smooth(t / 3000);
      return [6.9 + 0.5 * s, 45.95 + 0.2 * s, 13 - 4 * Math.sin(Math.PI * s), 0, 50 - 20 * Math.sin(Math.PI * s)];
    },
  },
  {
    // Cap jusqu'à ≈ 50°/s (le flyover de l'application le borne à 14°/s ; 0,004 au lieu de
    // 0,0015 faisait tourner la caméra à 520°/s, ce qu'aucun pilote ne fait).
    name: 'flyover sinueux',
    durationMs: 6_000,
    camera: (t) => {
      const u = t / 6000;
      const lng = 6.9 + 0.08 * u + 0.0015 * Math.sin(u * Math.PI * 8);
      const lat = 45.95 + 0.03 * u;
      const heading = (Math.atan2(0.08 + 0.0015 * Math.PI * 8 * Math.cos(u * Math.PI * 8), 0.03) * 180) / Math.PI;
      return [lng, lat, 14.5, normalizeAngle(heading), 62];
    },
  },
  {
    name: 'arrêt puis reprise',
    durationMs: 4_000,
    camera: (t) => {
      const progress = t < 1000 ? t / 1000 : t < 3000 ? 1 : 1 + (t - 3000) / 1000;
      return [6.9 + 0.02 * progress, 45.95, 13, 0, 50];
    },
  },
];

const SEND_INTERVAL_MS = 33;
const SETTLE_MS = 250;
const LATENCY_BASE_MS = 40;
const LATENCY_JITTER_MS = 60;
const SKIP_RATE = 0.01;
const STALL = { at: 1_500, ms: 300 };
const FPS = [30, 60, 144] as const;

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

const same = (a: Camera, b: Camera) => a.every((value, index) => value === b[index]);

/** Messages envoyés (temps de l'émetteur, caméra) puis leur arrivée (temps local, gigue, ordre conservé). */
function transmit(scenario: Scenario, seed: number, stall: boolean) {
  const rand = random(seed);
  const sent: Array<{ t: number; camera: Camera }> = [];
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastSent: Camera | null = null;
  let lastChangeAt = 0;
  let pending = false;
  let previous: Camera | null = null;
  // Images de l'émetteur (≈ 60 i/s, irrégulières) : un mouvement marque la caméra « à envoyer ».
  for (let t = 0; t <= scenario.durationMs + 1_000; t += 14 + rand() * 6) {
    const camera = scenario.camera(Math.min(t, scenario.durationMs));
    if (!previous || !same(previous, camera)) {
      pending = true;
      lastChangeAt = t;
    }
    previous = camera;
    const frozen = scenario.senderFreeze && t >= scenario.senderFreeze[0] && t < scenario.senderFreeze[1];
    if (pending && !frozen && t - lastSentAt >= SEND_INTERVAL_MS - 1) {
      if (!lastSent || !same(lastSent, camera)) sent.push({ t, camera });
      lastSent = camera;
      lastSentAt = t;
      pending = false;
    }
    // Image clé complète après l'arrêt (répare une perte).
    if (!pending && lastChangeAt > 0 && t - lastChangeAt >= SETTLE_MS && t - lastChangeAt < SETTLE_MS + 20) sent.push({ t, camera });
  }
  const clockSkew = 123_456; // horloges différentes : seul `t` de l'émetteur voyage
  let lastArrival = 0;
  const delivered: Array<{ t: number; arrival: number; camera: Camera }> = [];
  for (const message of sent) {
    if (rand() < SKIP_RATE && message.t < scenario.durationMs) continue;
    let arrival = message.t + LATENCY_BASE_MS + rand() * LATENCY_JITTER_MS;
    if (stall && message.t >= STALL.at && message.t < STALL.at + STALL.ms) arrival = Math.max(arrival, STALL.at + STALL.ms + LATENCY_BASE_MS);
    arrival = Math.max(arrival, lastArrival);
    lastArrival = arrival;
    delivered.push({ t: message.t + clockSkew, arrival, camera: message.camera });
  }
  return { delivered, clockSkew };
}

interface Run {
  lagMs: number;
  residual: number;
  maxStepRatio: number;
  finalExact: boolean;
  resumeLagMs: number | null;
  backwards: number;
}

function replay(scenario: Scenario, fps: number, seed: number, stall: boolean): Run {
  const { delivered, clockSkew } = transmit(scenario, seed, stall);
  const clock = new PlayoutClock();
  const track = new SampleTrack({ wrap: [3] });
  const frames: Array<{ now: number; camera: number[] }> = [];
  let next = 0;
  const end = scenario.durationMs + 1_500;
  for (let now = 0; now <= end; now += 1000 / fps) {
    while (next < delivered.length && delivered[next].arrival <= now) {
      const message = delivered[next];
      // Comme MotionStore : un trou dans ses horodatages n'est un repos que si son flux était posé.
      clock.observe(message.t, message.arrival, track.isSettled());
      track.push({ t: message.t, values: [...message.camera] });
      next += 1;
    }
    const sample = track.sample(clock.playbackTime(now));
    if (sample?.values) frames.push({ now, camera: sample.values });
  }

  // Amplitude de chaque composante (normalisation de l'écart).
  const truth = (t: number) => scenario.camera(Math.min(Math.max(t, 0), scenario.durationMs));
  const ranges = [0, 1, 2, 3, 4].map((index) => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t <= scenario.durationMs; t += 10) {
      const value = truth(t)[index];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return Math.max(max - min, 1e-9);
  });
  const errorAt = (frame: { now: number; camera: number[] }, lag: number) => {
    const reference = truth(frame.now - lag);
    let sum = 0;
    for (let index = 0; index < 5; index += 1) {
      const delta = index === 3 ? normalizeAngle(frame.camera[index] - reference[index]) : frame.camera[index] - reference[index];
      if (ranges[index] > 1e-6) sum += (delta / ranges[index]) ** 2;
    }
    return sum;
  };
  // Blocage du réseau ou émetteur figé : fidélité jugée 3 s après (le temps de rattraper le retard pris).
  const recovering = (now: number) => (stall && now >= STALL.at && now <= STALL.at + STALL.ms + 3_000)
    || (!!scenario.senderFreeze && now >= scenario.senderFreeze[0] && now <= scenario.senderFreeze[1] + 3_000);
  const moving = frames.filter((frame) => frame.now > 400 && frame.now < scenario.durationMs - 100 && !recovering(frame.now));
  let best = { lag: 0, error: Infinity };
  for (let lag = 0; lag <= 500; lag += 2) {
    let sum = 0;
    for (const frame of moving) sum += errorAt(frame, lag);
    const error = Math.sqrt(sum / Math.max(1, moving.length));
    if (error < best.error) best = { lag, error };
  }

  // Sauts : plus grand déplacement par image, rapporté à celui de la vraie caméra au même rythme.
  const stepOf = (a: number[], b: number[]) =>
    Math.hypot(...[0, 1, 2, 3, 4].map((index) => (index === 3 ? normalizeAngle(b[index] - a[index]) : b[index] - a[index]) / ranges[index]));
  let maxFollowStep = 0;
  for (let index = 1; index < frames.length; index += 1) maxFollowStep = Math.max(maxFollowStep, stepOf(frames[index - 1].camera, frames[index].camera));
  let maxTruthStep = 0;
  for (let t = 1000 / fps; t <= scenario.durationMs; t += 1000 / fps) maxTruthStep = Math.max(maxTruthStep, stepOf(truth(t - 1000 / fps), truth(t)));

  const last = frames[frames.length - 1].camera;
  const finalTruth = truth(scenario.durationMs);
  const finalExact = last.every((value, index) => Math.abs((index === 3 ? normalizeAngle(value - finalTruth[index]) : value - finalTruth[index])) < 1e-9);

  // Reprise après l'arrêt (« arrêt puis reprise ») : quand le suivi se remet à bouger.
  let resumeLagMs: number | null = null;
  if (scenario.name === 'arrêt puis reprise') {
    const restLng = truth(2_000)[0];
    const resumed = frames.find((frame) => frame.now > 3_000 && frame.camera[0] > restLng + 1e-7);
    resumeLagMs = resumed ? resumed.now - 3_000 : Infinity;
  }
  let backwards = 0;
  if (scenario.monotoneLng) for (let index = 1; index < frames.length; index += 1) if (frames[index].camera[0] < frames[index - 1].camera[0] - 1e-12) backwards += 1;
  void clockSkew;
  return { lagMs: best.lag, residual: best.error, maxStepRatio: maxFollowStep / Math.max(maxTruthStep, 1e-12), finalExact, resumeLagMs, backwards };
}

const failures: string[] = [];
const fail = (label: string) => failures.push(label);
console.log('scénario                  réseau     i/s   retard   écart    saut×   fin     reprise');
for (const scenario of SCENARIOS) {
  for (const stall of [false, true]) {
    const lags: number[] = [];
    for (const fps of FPS) {
      const run = replay(scenario, fps, 7, stall);
      lags.push(run.lagMs);
      const network = stall ? 'blocage' : 'gigue';
      console.log(
        `${scenario.name.padEnd(24)} ${network.padEnd(8)} ${String(fps).padStart(5)} ${`${run.lagMs} ms`.padStart(8)} ${`${(run.residual * 100).toFixed(2)} %`.padStart(8)} ${run.maxStepRatio.toFixed(2).padStart(7)}   ${run.finalExact ? 'exacte' : 'FAUSSE'}  ${run.resumeLagMs === null ? '' : `${run.resumeLagMs.toFixed(0)} ms`}`,
      );
      const where = `${scenario.name} (${network}) @${fps}`;
      if (!stall && run.lagMs > 200) fail(`${where} : retard ${run.lagMs} ms > 200`);
      if (run.residual > 0.015) fail(`${where} : écart ${(run.residual * 100).toFixed(2)} % > 1,5 %`);
      if (run.maxStepRatio > 2.5) fail(`${where} : saut ${run.maxStepRatio.toFixed(2)} × > 2,5`);
      if (!run.finalExact) fail(`${where} : position finale inexacte`);
      if (run.backwards > 0) fail(`${where} : ${run.backwards} retour(s) en arrière`);
      if (!stall && run.resumeLagMs !== null && run.resumeLagMs > run.lagMs + 80) fail(`${where} : reprise en ${run.resumeLagMs.toFixed(0)} ms (> retard + 80)`);
    }
    if (!stall && Math.max(...lags) - Math.min(...lags) > 30) fail(`${scenario.name} : retard dépendant du framerate (${lags.join(' / ')} ms)`);
  }
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} critère(s) non tenu(s) :\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log('\n✅ suivi : retard, fidélité, sans saut (blocage compris), reprise, fin exacte, indépendant du framerate');
}
