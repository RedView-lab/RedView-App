import { describe, expect, it } from 'vitest';

import {
  advancePoseByVelocity,
  approachVelocity,
  settleVelocity,
  targetVelocity,
  velocityMagnitude,
  ZERO_VELOCITY,
  type FreeCamVelocity,
} from './velocity';

const RESPONSE = { accelerateTimeS: 0.14, brakeTimeS: 0.32 };
const FORWARD = { forward: 1, strafe: 0, vertical: 0 };

/** Simule `durationS` secondes à `fps` images/s avec un input constant. */
function simulate(start: FreeCamVelocity, target: FreeCamVelocity, durationS: number, fps: number): FreeCamVelocity {
  let velocity = start;
  const frames = Math.round(durationS * fps);
  for (let index = 0; index < frames; index += 1) velocity = approachVelocity(velocity, target, 1 / fps, RESPONSE);
  return velocity;
}

describe('targetVelocity', () => {
  it('avance selon le bearing, à la vitesse demandée', () => {
    const north = targetVelocity(0, FORWARD, 10, 5);
    expect(north.northMps).toBeCloseTo(10);
    expect(north.eastMps).toBeCloseTo(0);
    const east = targetVelocity(90, FORWARD, 10, 5);
    expect(east.eastMps).toBeCloseTo(10);
    expect(east.northMps).toBeCloseTo(0);
  });

  it('diagonale normalisée, montée indépendante', () => {
    const diagonal = targetVelocity(0, { forward: 1, strafe: 1, vertical: 1 }, 10, 5);
    expect(Math.hypot(diagonal.eastMps, diagonal.northMps)).toBeCloseTo(10);
    expect(diagonal.upMps).toBe(5);
  });
});

describe('approachVelocity', () => {
  it('accélère progressivement, sans dépasser la cible', () => {
    const target = targetVelocity(0, FORWARD, 10, 5);
    const first = approachVelocity(ZERO_VELOCITY, target, 1 / 60, RESPONSE);
    expect(first.northMps).toBeGreaterThan(0);
    expect(first.northMps).toBeLessThan(2);
    const later = simulate(ZERO_VELOCITY, target, 0.5, 60);
    expect(later.northMps).toBeGreaterThan(9.5);
    expect(later.northMps).toBeLessThanOrEqual(10);
  });

  it('glisse au relâchement, plus longtemps qu’elle n’accélère', () => {
    const cruise = { eastMps: 0, northMps: 10, upMps: 0 };
    // 0,3 s après le départ : presque à pleine vitesse ; 0,3 s après le relâchement : encore de l'élan.
    expect(simulate(ZERO_VELOCITY, cruise, 0.3, 60).northMps).toBeGreaterThan(8.5);
    const gliding = simulate(cruise, ZERO_VELOCITY, 0.3, 60).northMps;
    expect(gliding).toBeGreaterThan(3);
    expect(gliding).toBeLessThan(5);
  });

  it('ne dépend pas du nombre d’images par seconde', () => {
    const target = targetVelocity(30, FORWARD, 25, 5);
    // 1/3 s : un nombre entier d'images aux deux cadences.
    const at30 = simulate(ZERO_VELOCITY, target, 1 / 3, 30);
    const at144 = simulate(ZERO_VELOCITY, target, 1 / 3, 144);
    expect(at30.eastMps).toBeCloseTo(at144.eastMps, 6);
    expect(at30.northMps).toBeCloseTo(at144.northMps, 6);
  });

  it('freine la montée sans adoucir l’avance', () => {
    const current = { eastMps: 0, northMps: 10, upMps: 5 };
    const target = targetVelocity(0, FORWARD, 10, 5); // « monter » relâché
    const next = approachVelocity(current, target, 0.1, RESPONSE);
    expect(next.northMps).toBeCloseTo(10);
    expect(next.upMps).toBeCloseTo(5 * Math.exp(-0.1 / RESPONSE.brakeTimeS));
  });
});

describe('settleVelocity', () => {
  it('arrête net sous le seuil sans input', () => {
    expect(settleVelocity({ eastMps: 0.01, northMps: 0, upMps: 0 }, ZERO_VELOCITY, 0.05)).toBe(ZERO_VELOCITY);
  });

  it('garde la glisse au-dessus du seuil, et toujours avec un input', () => {
    const gliding = { eastMps: 1, northMps: 0, upMps: 0 };
    expect(settleVelocity(gliding, ZERO_VELOCITY, 0.05)).toBe(gliding);
    const starting = { eastMps: 0.001, northMps: 0, upMps: 0 };
    expect(settleVelocity(starting, targetVelocity(0, FORWARD, 10, 5), 0.05)).toBe(starting);
  });

  it('une glisse finit toujours par s’arrêter', () => {
    let velocity: FreeCamVelocity = { eastMps: 0, northMps: 2_000, upMps: -300 };
    let frames = 0;
    while (velocity !== ZERO_VELOCITY && frames < 1_000) {
      velocity = settleVelocity(approachVelocity(velocity, ZERO_VELOCITY, 1 / 60, RESPONSE), ZERO_VELOCITY, 20);
      frames += 1;
    }
    expect(velocity).toBe(ZERO_VELOCITY);
    expect(frames).toBeLessThan(120);
    expect(velocityMagnitude(velocity)).toBe(0);
  });
});

describe('advancePoseByVelocity', () => {
  it('déplace la position et l’altitude, garde l’orientation', () => {
    const pose = { lng: 6.86, lat: 45.83, altitudeM: 2_000, pitch: 70, bearing: 45 };
    const next = advancePoseByVelocity(pose, { eastMps: 0, northMps: 111.32, upMps: -10 }, 1);
    expect(next.lat).toBeCloseTo(45.831, 6);
    expect(next.lng).toBeCloseTo(6.86, 9);
    expect(next.altitudeM).toBeCloseTo(1_990);
    expect(next.pitch).toBe(70);
    expect(next.bearing).toBe(45);
  });

  it('immobile à vitesse nulle', () => {
    const pose = { lng: 2.35, lat: 48.85, altitudeM: 300, pitch: 60, bearing: 0 };
    const next = advancePoseByVelocity(pose, ZERO_VELOCITY, 0.016);
    expect(next.lng).toBeCloseTo(pose.lng, 9);
    expect(next.lat).toBeCloseTo(pose.lat, 9);
    expect(next.altitudeM).toBe(pose.altitudeM);
  });
});
