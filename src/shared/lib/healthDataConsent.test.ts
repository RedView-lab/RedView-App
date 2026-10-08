import { describe, expect, it } from 'vitest';

import {
  HEALTH_DATA_CONSENT_VERSION,
  createHealthDataConsent,
  healthDataConsentMirrorKey,
  isHealthDataConsentValid,
  parseHealthDataConsent,
  readHealthDataConsentMirror,
  resolveHealthDataConsent,
  writeHealthDataConsentMirror,
} from './healthDataConsent';

/** Stockage en mémoire (même interface que localStorage). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

describe('consentement aux données de santé (.fit)', () => {
  it('lit un consentement bien formé et rejette le reste', () => {
    expect(parseHealthDataConsent({ version: 1, acceptedAt: '2026-10-08T10:00:00.000Z' }))
      .toEqual({ version: 1, acceptedAt: '2026-10-08T10:00:00.000Z' });
    for (const bad of [null, undefined, 'oui', true, {}, { version: 0, acceptedAt: '2026-10-08' }, { version: 1.5, acceptedAt: '2026-10-08' }, { version: 1, acceptedAt: 'hier' }, { version: '1', acceptedAt: '2026-10-08' }]) {
      expect(parseHealthDataConsent(bad)).toBeNull();
    }
  });

  it('ne vaut que pour la version actuelle du texte (un nouveau texte redemande l’accord)', () => {
    const current = createHealthDataConsent(new Date('2026-10-08T10:00:00Z'));
    expect(current).toEqual({ version: HEALTH_DATA_CONSENT_VERSION, acceptedAt: '2026-10-08T10:00:00.000Z' });
    expect(isHealthDataConsentValid(current)).toBe(true);
    expect(isHealthDataConsentValid(current, HEALTH_DATA_CONSENT_VERSION + 1)).toBe(false);
    expect(isHealthDataConsentValid({ ...current, version: HEALTH_DATA_CONSENT_VERSION + 1 })).toBe(false);
    expect(isHealthDataConsentValid(null)).toBe(false);
  });

  it('garde un miroir local par compte, effacé au retrait', () => {
    const storage = memoryStorage();
    const consent = createHealthDataConsent();
    writeHealthDataConsentMirror('moi', consent, storage);
    expect(readHealthDataConsentMirror('moi', storage)).toEqual(consent);
    expect(readHealthDataConsentMirror('autre', storage)).toBeNull();
    writeHealthDataConsentMirror('moi', null, storage);
    expect(storage.getItem(healthDataConsentMirrorKey('moi'))).toBeNull();
    storage.setItem(healthDataConsentMirrorKey('moi'), '{pas du json');
    expect(readHealthDataConsentMirror('moi', storage)).toBeNull();
  });

  it('suit le compte dès qu’il est lisible : un retrait fait ailleurs l’emporte sur le miroir', () => {
    const mirror = createHealthDataConsent();
    expect(resolveHealthDataConsent({ account: null, accountReadable: true, mirror })).toBeNull();
    expect(resolveHealthDataConsent({ account: null, accountReadable: false, mirror })).toEqual(mirror);
    const account = createHealthDataConsent(new Date('2026-01-01T00:00:00Z'));
    expect(resolveHealthDataConsent({ account, accountReadable: true, mirror: null })).toEqual(account);
  });
});
