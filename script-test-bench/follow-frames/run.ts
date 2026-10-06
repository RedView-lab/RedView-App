/**
 * RedView Test-Bench : suivre un éditeur, image par image, avec le vrai code
 * des deux côtés (présence en direct), dans un navigateur virtuel
 * (virtualBrowser.ts) — ce que bench-follow.ts ne voit pas (il rejoue des
 * échantillons parfaits avec une horloge unique) :
 *
 *  - émetteur : sa carte rend à 60 Hz (rendu de 3 à 7 ms, longues tâches façon
 *    rendu React), la caméra change à chaque image ; `PresenceBroadcaster`
 *    échantillonne (fin de rendu, ou minuterie retardée par le fil principal) ;
 *  - réseau : latence de base + gigue, ordre conservé, horloges différentes ;
 *  - celui qui suit : `MotionStore` + `FollowController` (caméra posée dans la
 *    file de rendu de Mapbox, horodatage rAF) + `PeerCursorsOverlay` (curseur
 *    repositionné à chaque `render` et dans sa propre boucle rAF), à 60 et
 *    144 Hz, dans les deux ordres possibles des rappels rAF (calque d'abord, ou
 *    Mapbox d'abord : l'ordre de la première image se garde ensuite).
 *
 * Deux profils : « nominal » (gigue 0–20 ms, longues tâches rares) aux critères
 * stricts, « dégradé » (gigue 0–60 ms, longue tâche de 20–35 ms toutes les
 * ≈ 0,7 s chez l'émetteur) aux critères de robustesse.
 *
 * Mesuré sur chaque image affichée, pendant le mouvement :
 *  - retard (décalage qui aligne le mieux la caméra suivie sur la vraie) ;
 *  - à-coups : variation d'une image à l'autre de l'écart de vitesse avec la
 *    vraie caméra, rapportée à sa vitesse (0 % = mouvement aussi régulier que
 *    l'original ; un rattrapage lent du retard n'en est pas un) ;
 *  - écart de vitesse : RMS de l'écart de vitesse (rattrapage, interpolation) ;
 *  - arrêts : images où la caméra suivie ne bouge presque pas alors que la
 *    vraie bouge (lecture affamée) ;
 *  - curseur de l'éditeur suivi (pointeur immobile sur son écran, mêmes
 *    écrans) : écart à sa position attendue, en px (p95, max).
 *
 * Avant correction (06/10/2026 : horodatage à l'envoi, curseurs lus avec
 * `performance.now()` pendant le rendu, délai de lecture sur la gigue p95) :
 * à-coups 24–57 %, 2 à 114 images arrêtées par passe, curseur à 1–7 px.
 *
 * Usage : npm run bench:follow-frames
 *   --verbose (une ligne par graine) --only=<début du nom> --seed=<n> --seeds=<nombre, 5 par défaut>
 *   --profile=nominal|dégradé --trace (vitesse de lecture de la 1re passe)
 */
import { MotionStore } from '../../src/features/livePresence/engine/MotionStore.ts';
import { FollowController } from '../../src/features/livePresence/engine/FollowController.ts';
import { PeerCursorsOverlay } from '../../src/features/livePresence/engine/PeerCursorsOverlay.ts';
import { PresenceBroadcaster } from '../../src/features/livePresence/engine/PresenceBroadcaster.ts';
import { normalizeAngle } from '../../src/features/livePresence/lib/playout.ts';
import type { MotionFields } from '../../src/features/collab/protocol.ts';
import type { Map as MapboxMap } from 'mapbox-gl';
import { FakeMap, Sim, Tab, installGlobals, type CameraValues, type FakeElement } from './virtualBrowser.ts';

interface Scenario {
  name: string;
  durationMs: number;
  camera(t: number): CameraValues;
  /** Pointeur de l'émetteur immobile sur son écran (px), au-dessus de la carte. */
  pointer?: [number, number];
}

interface Profile {
  name: string;
  latencyBaseMs: number;
  latencyJitterMs: number;
  leaderLongTaskEveryMs: number;
  followerLongTaskEveryMs: number;
  /**
   * Moyenne sur les graines (régularité d'ensemble) et pire passe (un retard
   * jamais vu — première longue tâche de l'émetteur — peut affamer une image,
   * puis le délai l'a appris).
   */
  targets: { meanJudder: number; worstJudder: number; meanSpeedError: number; stalls: number; cursorP95Px: number; lagMs: number };
}

const PROFILES: Profile[] = [
  {
    name: 'nominal',
    latencyBaseMs: 30,
    latencyJitterMs: 20,
    leaderLongTaskEveryMs: 3_000,
    followerLongTaskEveryMs: 3_000,
    targets: { meanJudder: 0.015, worstJudder: 0.06, meanSpeedError: 0.02, stalls: 1, cursorP95Px: 0.5, lagMs: 150 },
  },
  {
    name: 'dégradé',
    latencyBaseMs: 40,
    latencyJitterMs: 60,
    leaderLongTaskEveryMs: 700,
    followerLongTaskEveryMs: 900,
    targets: { meanJudder: 0.04, worstJudder: 0.1, meanSpeedError: 0.04, stalls: 1, cursorP95Px: 0.5, lagMs: 200 },
  },
];

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const BASE: CameraValues = { lng: 6.9, lat: 45.95, zoom: 13, bearing: 0, pitch: 50 };
const WIDTH = 1280;
const HEIGHT = 800;

/** Trajectoire de flyover : cap 20° ± 25° (période 4 s, ≤ 40°/s), 120 m/s au sol, précalculée à la milliseconde. */
const FLYOVER_PATH = (() => {
  const points: Array<[number, number, number]> = [];
  let lng = 6.9;
  let lat = 45.95;
  const metresPerDegreeLat = 111_320;
  for (let t = 0; t <= 6_000; t += 1) {
    const heading = 20 + 25 * Math.sin((2 * Math.PI * t) / 4_000);
    points.push([lng, lat, heading]);
    const radians = (heading * Math.PI) / 180;
    lat += (0.12 * Math.cos(radians)) / metresPerDegreeLat;
    lng += (0.12 * Math.sin(radians)) / (metresPerDegreeLat * Math.cos((lat * Math.PI) / 180));
  }
  return points;
})();

function flyoverCamera(t: number): CameraValues {
  const clamped = Math.min(Math.max(t, 0), 6_000);
  const index = Math.min(FLYOVER_PATH.length - 2, Math.floor(clamped));
  const u = clamped - index;
  const [lngA, latA, headingA] = FLYOVER_PATH[index];
  const [lngB, latB, headingB] = FLYOVER_PATH[index + 1];
  return { lng: lngA + (lngB - lngA) * u, lat: latA + (latB - latA) * u, zoom: 14.5, bearing: headingA + (headingB - headingA) * u, pitch: 62 };
}

const SCENARIOS: Scenario[] = [
  { name: 'panoramique', durationMs: 4_000, camera: (t) => ({ ...BASE, lng: BASE.lng + 0.05 * Math.min(1, t / 4000) }) },
  {
    name: 'panoramique + pointeur',
    durationMs: 4_000,
    camera: (t) => ({ ...BASE, lng: BASE.lng + 0.05 * Math.min(1, t / 4000) }),
    pointer: [820, 360],
  },
  {
    // Rotation d'inactivité avec la souris posée sur la carte : le pointeur change à chaque image.
    name: 'rotation (pointeur)',
    durationMs: 5_000,
    camera: (t) => ({ ...BASE, bearing: normalizeAngle(150 + (12 * Math.min(t, 5000)) / 1000) }),
    pointer: [760, 420],
  },
  {
    name: 'zoom',
    durationMs: 3_000,
    camera: (t) => ({ ...BASE, zoom: 11 + 3 * smooth(t / 3000) }),
    pointer: [700, 300],
  },
  { name: 'flyover sinueux', durationMs: 6_000, camera: flyoverCamera, pointer: [640, 520] },
  {
    name: 'rotation rapide ±180°',
    durationMs: 3_000,
    camera: (t) => ({ ...BASE, bearing: normalizeAngle(-170 + 120 * smooth(t / 3000)), pitch: 60 }),
    pointer: [700, 380],
  },
];

const FOLLOWER_HZ = [60, 144] as const;
const ORDERS = ['calque d’abord', 'Mapbox d’abord'] as const;
type Order = (typeof ORDERS)[number];
const CLOCK_SKEW_MS = 98_765.4;
/** Fenêtre de mesure : après le démarrage du suivi (fondu, estimation de la gigue), avant l'arrêt. */
const MEASURE_FROM_MS = 900;
const MEASURE_UNTIL_END_MS = 150;

const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const VERBOSE = process.argv.includes('--verbose');
const TRACE = process.argv.includes('--trace');
const ONLY = argument('only');
const SEED = argument('seed');
const PROFILE = argument('profile');
const SEED_COUNT = Number(argument('seeds') ?? 5);
const SEEDS = SEED ? [Number(SEED)] : [11, 23, 37, 53, 71, 89, 97, 113].slice(0, SEED_COUNT);
let traced = false;

const COMPONENTS: Array<keyof CameraValues> = ['lng', 'lat', 'zoom', 'bearing', 'pitch'];

interface FrameRecord {
  time: number;
  camera: CameraValues;
  cursor: [number, number] | null;
}

interface RunResult {
  lagMs: number;
  /** Variation d'une image à l'autre de l'écart de vitesse (à-coups visibles), rapportée à la vitesse vraie. */
  judder: number;
  /** Écart de vitesse (rattrapage lent du retard, interpolation entre échantillons), rapporté à la vitesse vraie. */
  speedError: number;
  stalls: number;
  cursorP95: number;
  cursorMax: number;
  stopped: string | null;
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function parseTransform(transform: string): [number, number] | null {
  const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(transform);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function runPass(scenario: Scenario, profile: Profile, followerHz: number, order: Order, seed: number): RunResult {
  const sim = new Sim();
  const created: FakeElement[] = [];
  const restore = installGlobals(sim, created);
  try {
    const leaderTab = new Tab({ name: 'émetteur', vsyncMs: 1000 / 60, vsyncPhase: 3.1, longTaskEveryMs: profile.leaderLongTaskEveryMs, longTaskMs: [20, 35], timerSlopMs: [0, 2], seed });
    const followerTab = new Tab({ name: 'suiveur', vsyncMs: 1000 / followerHz, vsyncPhase: 7.7, longTaskEveryMs: profile.followerLongTaskEveryMs, longTaskMs: [15, 30], timerSlopMs: [0, 2], seed: seed + 1 });
    const leaderMap = new FakeMap({ sim, tab: leaderTab, width: WIDTH, height: HEIGHT, camera: scenario.camera(0), renderCostMs: () => 3 + leaderTab.rand() * 4 });
    const followerMap = new FakeMap({ sim, tab: followerTab, width: WIDTH, height: HEIGHT, camera: scenario.camera(0), renderCostMs: () => 3 + followerTab.rand() * 6 });
    const truth = (t: number) => scenario.camera(Math.min(Math.max(t, 0), scenario.durationMs));

    // ── Émetteur : caméra rendue à chaque image tant qu'elle bouge.
    leaderMap.beforeRender = (time) => {
      if (time > scenario.durationMs + 400) return;
      leaderMap.setCameraDuringRender(truth(time));
      leaderMap.triggerRepaint();
    };
    const store = new MotionStore();
    let lastArrival = 0;
    const realtime = {
      clientId: 'leader',
      subscribeMotion: () => () => {},
      sendMotion: (t: number, fields: MotionFields) => {
        let arrival = leaderTab.now + profile.latencyBaseMs + leaderTab.rand() * profile.latencyJitterMs;
        // TCP : l'ordre est conservé.
        arrival = Math.max(arrival, lastArrival);
        lastArrival = arrival;
        const message = { from: 'leader', t: t + CLOCK_SKEW_MS, fields: structuredClone(fields), snapshot: false };
        sim.schedule(followerTab, arrival, () => {
          // Message WebSocket : petite tâche du suiveur.
          sim.advance(0.2);
          store.ingest(message);
        });
        return true;
      },
      canSendVolatile: () => true,
      updatePresence: () => {},
    };
    const broadcaster = sim.within(leaderTab, () => {
      const instance = new PresenceBroadcaster(leaderMap as unknown as MapboxMap, realtime);
      instance.connect();
      instance.setOthersPresent(true);
      instance.setWatched(true);
      if (scenario.pointer) {
        leaderMap.fire('mousemove', { point: { x: scenario.pointer[0], y: scenario.pointer[1] } });
      }
      leaderMap.triggerRepaint();
      return instance;
    });

    // ── Celui qui suit.
    let stopped: string | null = null;
    const frames: FrameRecord[] = [];
    const { overlay, controller } = sim.within(followerTab, () => {
      const map = followerMap as unknown as MapboxMap;
      const cursorsOverlay = new PeerCursorsOverlay(map, store);
      const follow = new FollowController(map, store, { onStop: (reason) => { stopped = reason; } });
      const peer = { clientId: 'leader', name: 'Alice', color: '#e5484d', ink: '#ffffff' };
      // Ordre des abonnements au MotionStore = ordre des premières demandes d'image.
      if (order === 'calque d’abord') {
        cursorsOverlay.connect();
        cursorsOverlay.setPeers([peer]);
        follow.start('leader');
      } else {
        follow.start('leader');
        cursorsOverlay.connect();
        cursorsOverlay.setPeers([peer]);
      }
      return { overlay: cursorsOverlay, controller: follow };
    });
    const cursorElement = () => created.find((element) => element.className === 'rv-peer-cursor') ?? null;
    const trace: Array<{ time: number; playback: number; newest: number }> = [];
    followerTab.onFrameEnd = (time) => {
      const element = cursorElement();
      const visible = element?.classList.contains('is-visible') ?? false;
      frames.push({ time, camera: followerMap.getCamera(), cursor: visible ? parseTransform(element!.style.transform) : null });
      if (TRACE && !traced) {
        const clock = (store as unknown as { peers: Map<string, { clock: Record<string, number> }> }).peers.get('leader')?.clock;
        if (clock && clock.lastPlayback !== null) trace.push({ time, playback: clock.lastPlayback, newest: clock.lastSenderT });
      }
    };

    sim.startTab(leaderTab);
    sim.startTab(followerTab);
    sim.runUntil(scenario.durationMs + 1_500);
    sim.within(leaderTab, () => broadcaster.disconnect());
    sim.within(followerTab, () => {
      controller.dispose();
      overlay.disconnect();
    });

    if (TRACE && !traced) {
      traced = true;
      const speeds: number[] = [];
      let starved = 0;
      for (let index = 1; index < trace.length; index += 1) {
        const a = trace[index - 1];
        const b = trace[index];
        if (b.time < MEASURE_FROM_MS || b.time > scenario.durationMs - MEASURE_UNTIL_END_MS) continue;
        speeds.push((b.playback - a.playback) / (b.time - a.time));
        if (Math.abs(b.playback - b.newest) < 1e-6) {
          starved += 1;
          console.log(`  lecture affamée à t=${b.time.toFixed(1)} (temps de l'émetteur ${(b.playback - CLOCK_SKEW_MS).toFixed(1)})`);
        }
      }
      console.log(`  trace ${scenario.name} @${followerHz} Hz : ${speeds.length} images, ${starved} affamée(s), vitesse de lecture p1 ${percentile(speeds, 0.01).toFixed(3)} p50 ${percentile(speeds, 0.5).toFixed(3)} p99 ${percentile(speeds, 0.99).toFixed(3)}`);
    }

    // ── Mesures.
    const ranges = COMPONENTS.map((key) => {
      let min = Infinity;
      let max = -Infinity;
      for (let t = 0; t <= scenario.durationMs; t += 10) {
        const value = truth(t)[key];
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return Math.max(max - min, 1e-9);
    });
    const delta = (a: CameraValues, b: CameraValues) => COMPONENTS.map((key, index) => {
      const raw = key === 'bearing' ? normalizeAngle(b[key] - a[key]) : b[key] - a[key];
      return ranges[index] > 1e-6 ? raw / ranges[index] : 0;
    });
    const norm = (vector: number[]) => Math.hypot(...vector);
    const measured = (frame: FrameRecord) => frame.time > MEASURE_FROM_MS && frame.time < scenario.durationMs - MEASURE_UNTIL_END_MS;
    // Image affichée à `time` : ce que la vraie caméra montrait à `time − retard`.
    const moving = frames.filter(measured);
    let best = { lag: 0, error: Infinity };
    for (let lag = 0; lag <= 400; lag += 1) {
      let sum = 0;
      for (const frame of moving) sum += norm(delta(truth(frame.time - lag), frame.camera)) ** 2;
      const error = Math.sqrt(sum / Math.max(1, moving.length));
      if (error < best.error) best = { lag, error };
    }
    const truthSteps: number[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      if (!measured(frames[index])) continue;
      truthSteps.push(norm(delta(truth(frames[index - 1].time - best.lag), truth(frames[index].time - best.lag))));
    }
    const typicalStep = percentile(truthSteps, 0.5);
    let speedErrorSum = 0;
    let jerkSum = 0;
    let truthSum = 0;
    let stalls = 0;
    let previousError: number[] | null = null;
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const frame = frames[index];
      if (!measured(frame)) continue;
      const followed = delta(previous.camera, frame.camera);
      const expected = delta(truth(previous.time - best.lag), truth(frame.time - best.lag));
      // Vitesses par ms (une image sautée par une longue tâche du suiveur garde son poids).
      const dt = frame.time - previous.time;
      const error = followed.map((value, component) => (value - expected[component]) / dt);
      speedErrorSum += norm(error) ** 2;
      truthSum += (norm(expected) / dt) ** 2;
      if (previousError) jerkSum += norm(error.map((value, component) => value - previousError![component])) ** 2;
      previousError = error;
      if (norm(expected) > 0.3 * typicalStep && norm(followed) < 0.25 * norm(expected)) stalls += 1;
    }
    const cursorErrors: number[] = [];
    if (scenario.pointer) {
      for (const frame of moving) {
        if (frame.cursor) cursorErrors.push(Math.hypot(frame.cursor[0] - scenario.pointer[0], frame.cursor[1] - scenario.pointer[1]));
      }
    }
    return {
      lagMs: best.lag,
      judder: Math.sqrt(jerkSum / Math.max(truthSum, 1e-30)),
      speedError: Math.sqrt(speedErrorSum / Math.max(truthSum, 1e-30)),
      stalls,
      cursorP95: percentile(cursorErrors, 0.95),
      cursorMax: cursorErrors.length > 0 ? Math.max(...cursorErrors) : 0,
      stopped,
    };
  } finally {
    restore();
  }
}

const failures: string[] = [];
for (const profile of PROFILES.filter((candidate) => !PROFILE || candidate.name === PROFILE)) {
  const { targets } = profile;
  console.log(`\n── Profil ${profile.name} : latence ${profile.latencyBaseMs} ms + gigue 0–${profile.latencyJitterMs} ms, longues tâches ≈ ${profile.leaderLongTaskEveryMs} ms (émetteur) / ${profile.followerLongTaskEveryMs} ms (suiveur)`);
  console.log(`   critères (${SEEDS.length} graines) : à-coups moyens ≤ ${targets.meanJudder * 100} % (pire passe ≤ ${targets.worstJudder * 100} %), vitesse moyenne ≤ ${targets.meanSpeedError * 100} %, arrêts ≤ ${targets.stalls} par passe, curseur p95 ≤ ${targets.cursorP95Px} px, retard ≤ ${targets.lagMs} ms`);
  console.log('scénario                  suiveur  ordre rAF          retard   à-coups moy/pire  vitesse  arrêts  curseur p95 / max');
  for (const scenario of SCENARIOS.filter((candidate) => !ONLY || candidate.name.startsWith(ONLY))) {
    for (const hz of FOLLOWER_HZ) {
      for (const order of ORDERS) {
        const results = SEEDS.map((seed) => runPass(scenario, profile, hz, order, seed));
        const worst = (key: keyof Omit<RunResult, 'stopped'>) => Math.max(...results.map((result) => result[key]));
        const mean = (key: keyof Omit<RunResult, 'stopped'>) => results.reduce((sum, result) => sum + result[key], 0) / results.length;
        const stopped = results.find((result) => result.stopped)?.stopped ?? null;
        if (VERBOSE) {
          for (const [index, result] of results.entries()) console.log(`   graine ${SEEDS[index]} : ${JSON.stringify(result)}`);
        }
        const cursor = scenario.pointer ? `${worst('cursorP95').toFixed(2)} / ${worst('cursorMax').toFixed(2)} px` : '—';
        console.log(
          `${scenario.name.padEnd(25)} ${`${hz} Hz`.padStart(7)}  ${order.padEnd(17)} ${`${worst('lagMs')} ms`.padStart(7)} ${`${(mean('judder') * 100).toFixed(1)} / ${(worst('judder') * 100).toFixed(1)} %`.padStart(16)} ${`${(mean('speedError') * 100).toFixed(1)} %`.padStart(8)} ${String(worst('stalls')).padStart(7)}  ${cursor}`,
        );
        const where = `[${profile.name}] ${scenario.name} @${hz} Hz (${order})`;
        if (stopped) failures.push(`${where} : suivi arrêté (${stopped})`);
        if (worst('lagMs') > targets.lagMs) failures.push(`${where} : retard ${worst('lagMs')} ms > ${targets.lagMs}`);
        if (mean('judder') > targets.meanJudder) failures.push(`${where} : à-coups moyens ${(mean('judder') * 100).toFixed(1)} % > ${targets.meanJudder * 100} %`);
        if (worst('judder') > targets.worstJudder) failures.push(`${where} : à-coups ${(worst('judder') * 100).toFixed(1)} % (pire passe) > ${targets.worstJudder * 100} %`);
        if (mean('speedError') > targets.meanSpeedError) failures.push(`${where} : écart de vitesse moyen ${(mean('speedError') * 100).toFixed(1)} % > ${targets.meanSpeedError * 100} %`);
        if (worst('stalls') > targets.stalls) failures.push(`${where} : ${worst('stalls')} image(s) arrêtée(s)`);
        if (scenario.pointer && worst('cursorP95') > targets.cursorP95Px) failures.push(`${where} : curseur à ${worst('cursorP95').toFixed(2)} px (p95) > ${targets.cursorP95Px}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} critère(s) non tenu(s) :\n - ${failures.join('\n - ')}`);
  process.exitCode = 1;
} else {
  console.log('\n✅ suivi image par image : mouvement régulier, lecture jamais affamée, curseur à sa place, dans les deux ordres rAF, à 60 et 144 Hz');
}
