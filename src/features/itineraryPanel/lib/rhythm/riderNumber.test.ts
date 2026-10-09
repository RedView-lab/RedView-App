import { describe, expect, it } from 'vitest';

import { FTP_RULE, SYSTEM_WEIGHT_RULE, formatRiderNumber, isRiderNumberKey, parseRiderNumber } from './riderNumber';

describe('parseRiderNumber', () => {
  it('poids : virgule ou point, une décimale, espaces ignorés', () => {
    expect(parseRiderNumber('82,5', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'value', value: 82.5 });
    expect(parseRiderNumber('82.5', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'value', value: 82.5 });
    expect(parseRiderNumber(' 82 ', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'value', value: 82 });
    // en cours de frappe
    expect(parseRiderNumber('82,', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'value', value: 82 });
    expect(parseRiderNumber('82,55', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'invalid' });
  });

  it('jamais 825 kg pour « 82,5 », et rien hors des bornes', () => {
    expect(parseRiderNumber('825', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'invalid' });
    expect(parseRiderNumber('8', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'invalid' });
    expect(parseRiderNumber('8,2,5', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'invalid' });
  });

  it('FTP : entier, « 1 200 » accepté, décimale refusée', () => {
    expect(parseRiderNumber('1 200', FTP_RULE)).toEqual({ kind: 'value', value: 1200 });
    expect(parseRiderNumber('1\u202f200', FTP_RULE)).toEqual({ kind: 'value', value: 1200 });
    expect(parseRiderNumber('250,5', FTP_RULE)).toEqual({ kind: 'invalid' });
    expect(parseRiderNumber('20', FTP_RULE)).toEqual({ kind: 'invalid' });
  });

  it('vide : pas de valeur', () => {
    expect(parseRiderNumber('', FTP_RULE)).toEqual({ kind: 'empty' });
    expect(parseRiderNumber('  ', SYSTEM_WEIGHT_RULE)).toEqual({ kind: 'empty' });
  });
});

describe('frappe et affichage', () => {
  it('le séparateur décimal n’est accepté que là où la règle en a', () => {
    expect(isRiderNumberKey(',', SYSTEM_WEIGHT_RULE)).toBe(true);
    expect(isRiderNumberKey('.', SYSTEM_WEIGHT_RULE)).toBe(true);
    expect(isRiderNumberKey(',', FTP_RULE)).toBe(false);
    expect(isRiderNumberKey('7', FTP_RULE)).toBe(true);
    expect(isRiderNumberKey('e', SYSTEM_WEIGHT_RULE)).toBe(false);
  });

  it('virgule en français, point en anglais', () => {
    expect(formatRiderNumber(82.5, SYSTEM_WEIGHT_RULE, 'fr')).toBe('82,5');
    expect(formatRiderNumber(82.5, SYSTEM_WEIGHT_RULE, 'en')).toBe('82.5');
    expect(formatRiderNumber(1200, FTP_RULE, 'fr')).toBe('1200');
  });
});
