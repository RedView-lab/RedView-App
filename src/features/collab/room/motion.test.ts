import { describe, expect, it } from 'vitest';

import { mergeMotion, MOTION_BURST, MotionBucket, sanitizeMotion } from './motion';

const CAM = [6.8694, 45.9237, 13.5, -20, 60, 36.87];
const VP = [1600, 900, 64, 360, 300, 420, 0, 0, 0, 0];

describe('motion : nettoyage d’un message reçu', () => {
  it('garde les champs connus et valides, rien d’autre', () => {
    const clean = sanitizeMotion({ type: 'motion', t: 1234.5, cam: CAM, vp: VP, ptr: [6.87, 45.92], chart: ['it-1', 4200], extra: 'x' });
    expect(clean).toEqual({ t: 1234.5, cam: CAM, vp: VP, ptr: [6.87, 45.92], chart: ['it-1', 4200] });
    expect(clean).not.toHaveProperty('extra');
  });

  it('null = pointeur hors de la carte, rien de survolé', () => {
    expect(sanitizeMotion({ t: 1, ptr: null, chart: null })).toEqual({ t: 1, ptr: null, chart: null });
  });

  it('ignore le message entier dès qu’un champ présent est invalide', () => {
    expect(sanitizeMotion({ t: 1, cam: [0, 95, 10, 0, 0, 36] })).toBeNull(); // latitude
    expect(sanitizeMotion({ t: 1, cam: [0, 0, 10, 0, 91, 36] })).toBeNull(); // inclinaison
    expect(sanitizeMotion({ t: 1, cam: [0, 0, 10, 0, 0, Number.NaN] })).toBeNull();
    expect(sanitizeMotion({ t: 1, cam: [0, 0, 10] })).toBeNull();
    expect(sanitizeMotion({ t: 1, vp: [0, 900, 0, 0, 0, 0, 0, 0, 0, 0] })).toBeNull(); // largeur nulle
    expect(sanitizeMotion({ t: 1, vp: [1600, 900, -1, 0, 0, 0, 0, 0, 0, 0] })).toBeNull();
    expect(sanitizeMotion({ t: 1, ptr: ['6', 45] })).toBeNull();
    expect(sanitizeMotion({ t: 1, chart: ['', 10] })).toBeNull();
    expect(sanitizeMotion({ t: 1, chart: ['x'.repeat(201), 10] })).toBeNull();
    expect(sanitizeMotion({ t: 1, chart: ['it-1', -5] })).toBeNull();
    expect(sanitizeMotion({ cam: CAM })).toBeNull(); // sans horodatage
    expect(sanitizeMotion({ t: -1 })).toBeNull();
    expect(sanitizeMotion(null)).toBeNull();
    expect(sanitizeMotion('motion')).toBeNull();
  });

  it('accepte une longitude déroulée au-delà de l’antiméridien', () => {
    expect(sanitizeMotion({ t: 1, ptr: [190, 10] })).toEqual({ t: 1, ptr: [190, 10] });
  });
});

describe('motion : dernier état connu', () => {
  it('chaque champ reçu remplace l’ancien, les autres restent', () => {
    const first = mergeMotion(null, 'a', { t: 1, cam: CAM as never, vp: VP as never, ptr: [1, 2] });
    const second = mergeMotion(first, 'a', { t: 2, ptr: null });
    expect(second).toEqual({ clientId: 'a', t: 2, cam: CAM, vp: VP, ptr: null });
    expect(first.ptr).toEqual([1, 2]);
  });
});

describe('motion : seau à jetons', () => {
  it('laisse passer la rafale, puis le débit tenu', () => {
    const bucket = new MotionBucket(40, MOTION_BURST);
    let passed = 0;
    for (let index = 0; index < 100; index += 1) if (bucket.take(0)) passed += 1;
    expect(passed).toBe(MOTION_BURST);
    // 1 s plus tard : 40 jetons de plus, plafonnés à la rafale.
    passed = 0;
    for (let index = 0; index < 100; index += 1) if (bucket.take(1000)) passed += 1;
    expect(passed).toBe(MOTION_BURST);
  });

  it('un client à 30 Hz n’est jamais limité', () => {
    const bucket = new MotionBucket();
    for (let index = 0; index < 600; index += 1) expect(bucket.take(index * (1000 / 30))).toBe(true);
  });

  it('une horloge qui recule ne crée pas de jetons', () => {
    const bucket = new MotionBucket(40, 2);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(500)).toBe(false);
  });
});
