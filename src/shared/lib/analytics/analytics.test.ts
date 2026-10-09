import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountAgeBucket, countBucket, durationBucket, percentBucket, projectAgeBucket, roundTo } from './buckets';
import { prepareUmamiPayload, sanitizeReferrer, type BeforeSendContext } from './beforeSend';
import {
  clearAnalyticsContext,
  flushAnalyticsQueue,
  getBeforeSendContext,
  registerAnalyticsPageHideSummary,
  resetAnalyticsStateForTests,
  runAnalyticsPageHideSummaries,
  setAnalyticsContext,
  trackAnalyticsEvent,
  trackAnalyticsEventThrottled,
  trackScreen,
} from './core';
import { analyticsAttrs } from './index';
import { EVENT_LABELS, PROPERTY_LABELS, toDisplayData, VALUE_LABELS } from './labels';
import { releaseTag } from './loader';
import { isAnalyticsOptedOut, setAnalyticsOptOut } from './optOut';
import { REDACTED, sanitizeAnalyticsData } from './privacy';

const NOW = Date.UTC(2026, 9, 7, 12);
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const ORIGIN = 'https://app.redview.tech';
const context = (patch: Partial<BeforeSendContext> = {}): BeforeSendContext => ({
  screen: 'projects',
  superProps: { surface: 'app', plan: 'demo', account_age: 'd1_7', lang: 'fr' },
  excluded: false,
  origin: ORIGIN,
  ...patch,
});

describe('tranches', () => {
  it('ancienneté d’un projet rouvert', () => {
    expect(projectAgeBucket(daysAgo(0.2), NOW)).toBe('today');
    expect(projectAgeBucket(daysAgo(3), NOW)).toBe('this_week');
    expect(projectAgeBucket(daysAgo(12), NOW)).toBe('this_month');
    expect(projectAgeBucket(daysAgo(90), NOW)).toBe('older');
    expect(projectAgeBucket(undefined, NOW)).toBe('unknown');
    expect(projectAgeBucket('pas une date', NOW)).toBe('unknown');
  });

  it('ancienneté du compte', () => {
    expect(accountAgeBucket(daysAgo(0.5), NOW)).toBe('d0');
    expect(accountAgeBucket(daysAgo(1), NOW)).toBe('d1_7');
    expect(accountAgeBucket(daysAgo(7.9), NOW)).toBe('d1_7');
    expect(accountAgeBucket(daysAgo(8), NOW)).toBe('d8_30');
    expect(accountAgeBucket(daysAgo(31), NOW)).toBe('d30_plus');
    expect(accountAgeBucket(null, NOW)).toBeUndefined();
  });

  it('comptes, arrondis, durées, avancement', () => {
    expect([0, 1, 2, 5, 6, 20, 21, 100, 101, 5000].map(countBucket)).toEqual(['0', '1', '2-5', '2-5', '6-20', '6-20', '21-100', '21-100', '>100', '>100']);
    expect(roundTo(1234, 10)).toBe(1230);
    expect(roundTo(1250, 100)).toBe(1300);
    expect(roundTo(Number.NaN, 10)).toBe(0);
    expect([200, 1500, 9000, 12_000, 45_000, 90_000].map(durationBucket)).toEqual(['<1s', '1-3s', '3-10s', '10-30s', '30-60s', '>60s']);
    expect([0, 0.3, 0.6, 0.8, 1].map(percentBucket)).toEqual(['<25', '25-50', '50-75', '75-99', '100']);
  });
});

describe('garde vie privée', () => {
  it('garde catégories, tranches et nombres arrondis', () => {
    expect(sanitizeAnalyticsData({ layer: 'slopes', enabled: true, distance_km: 120.123456, points: '6-20' })).toEqual({
      data: { layer: 'slopes', enabled: true, distance_km: 120.1235, points: '6-20' },
      rejected: [],
    });
  });

  it('remplace e-mail, ids Appwrite, UUID, jetons et textes longs', () => {
    const { data, rejected } = sanitizeAnalyticsData({
      email: 'victor@example.com',
      project: '6ac3e0220032afb63f87',
      session: '0f8fad5b-d9cb-469f-a165-70867728950e',
      secret: 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7',
      name: 'x'.repeat(65),
    });
    expect(data).toEqual({ email: REDACTED, project: REDACTED, session: REDACTED, secret: REDACTED, name: REDACTED });
    expect(rejected).toHaveLength(5);
  });

  it('refuse les clés hors format, les objets et les nombres non finis', () => {
    expect(sanitizeAnalyticsData({ 'Bad-Key': 'x', nested: { a: 1 }, n: Number.POSITIVE_INFINITY })).toEqual({
      data: undefined,
      rejected: ['Bad-Key', 'nested', 'n'],
    });
    expect(sanitizeAnalyticsData(null)).toEqual({ data: undefined, rejected: [] });
  });
});

describe('before-send', () => {
  it('URL de projet → écran éditeur, titre fixe, aucun nom ni id', () => {
    const out = prepareUmamiPayload('event', {
      url: `${ORIGIN}/project/projet-qui-tue--6ac3e0220032afb63f87`,
      title: 'PROJET QUI TUE · RedView',
      referrer: '',
      hostname: 'app.redview.tech',
    }, context({ screen: 'editor' }));
    expect(out).toMatchObject({ url: '/editeur-3d', title: 'Éditeur 3D', hostname: 'app.redview.tech' });
    expect(JSON.stringify(out)).not.toMatch(/6ac3e|QUI TUE|qui-tue/i);
  });

  it('lien de réinitialisation : ni secret ni userId ni e-mail ; utm gardés', () => {
    const out = prepareUmamiPayload('event', {
      url: `${ORIGIN}/?userId=6ab21085001928258582&secret=deadbeefcafe0123456789&expire=2026&email=a%40b.fr&utm_source=instagram&utm_campaign=beta&fbclid=XYZ`,
      referrer: `/?userId=6ab21085001928258582&secret=deadbeef`,
    }, context({ screen: 'reset_password' }));
    expect(out?.url).toBe('/mot-de-passe-oublie?utm_source=instagram&utm_campaign=beta');
    expect(out?.referrer).toBe('');
    expect(JSON.stringify(out)).not.toMatch(/secret|userId|6ab21085|fbclid|%40/);
  });

  it('page vue virtuelle gardée telle quelle', () => {
    expect(prepareUmamiPayload('event', { url: '/projets/reglages', title: 'x' }, context({ screen: 'editor' }))).toMatchObject({
      url: '/projets/reglages',
      title: 'Réglages',
    });
  });

  it('URL réelle « / » → écran courant (connexion ou projets)', () => {
    expect(prepareUmamiPayload('event', { url: `${ORIGIN}/` }, context({ screen: 'login' }))?.url).toBe('/connexion');
    expect(prepareUmamiPayload('event', { url: `${ORIGIN}/viewer?tile=0965_6500` }, context({ screen: 'viewer' }))?.url).toBe('/viewer-lidar');
  });

  it('arrondit les mesures du traceur (Web Vitals) : pas de flottant à 17 chiffres', () => {
    const out = prepareUmamiPayload('event', { url: `${ORIGIN}/`, cls: 0.00025900000000000006, lcp: 1234.5678, inp: 48, fcp: 0.4567 }, context({ screen: 'login' }));
    expect(out).toMatchObject({ cls: 0, lcp: 1235, inp: 48, fcp: 0.457 });
    expect(JSON.stringify(out)).not.toMatch(/[0-9]{8}/);
  });

  it('referrer : origine externe seulement', () => {
    expect(sanitizeReferrer('https://l.instagram.com/?u=https%3A%2F%2Fapp.redview.tech&e=AT0', ORIGIN)).toBe('https://l.instagram.com');
    expect(sanitizeReferrer('https://redview.tech/pricing?email=a@b.fr', ORIGIN)).toBe('https://redview.tech');
    expect(sanitizeReferrer('https://accounts.google.com/o/oauth2', ORIGIN)).toBe('');
    expect(sanitizeReferrer(`${ORIGIN}/project/x--6ac3e0220032afb63f87`, ORIGIN)).toBe('');
    expect(sanitizeReferrer('/project/x', ORIGIN)).toBe('');
    expect(sanitizeReferrer('javascript:alert(1)', ORIGIN)).toBe('');
  });

  it('événement : contexte commun ajouté, filtré, puis en français courant', () => {
    const out = prepareUmamiPayload('event', {
      url: `${ORIGIN}/`,
      name: 'layer_toggled',
      data: { layer: 'slopes', enabled: true, email: 'a@b.fr' },
    }, context());
    expect(out?.name).toBe('Couche de carte allumée ou éteinte');
    expect(out?.data).toEqual({
      espace: 'Application',
      formule: 'Bêta gratuite',
      'ancienneté du compte': 'Première semaine',
      'langue de l’app': 'Français',
      couche: 'Pentes',
      allumé: 'oui',
      email: REDACTED,
    });
  });

  it('nom d’événement hors format refusé, identify refusé, id distinct retiré', () => {
    expect(prepareUmamiPayload('event', { url: '/', name: 'Bad Name' }, context())).toBeNull();
    expect(prepareUmamiPayload('identify', { url: '/', data: { email: 'a@b.fr' } }, context())).toBeNull();
    expect(prepareUmamiPayload('event', { url: '/', id: 'user-1' }, context())).not.toHaveProperty('id');
  });

  it('Web Vitals : URL réécrite, mesures gardées, pas de données', () => {
    const out = prepareUmamiPayload('performance', {
      url: `${ORIGIN}/project/simon--6ac3e0220032afb63f87`,
      lcp: 2400,
      inp: 96,
      data: { x: 1 },
    }, context({ screen: 'projects' }));
    expect(out).toMatchObject({ url: '/editeur-3d', lcp: 2400, inp: 96 });
    expect(out).not.toHaveProperty('data');
  });

  it('compte interne : rien ne part', () => {
    expect(prepareUmamiPayload('event', { url: '/' }, context({ excluded: true }))).toBeNull();
    expect(prepareUmamiPayload('performance', { url: '/', lcp: 1 }, context({ excluded: true }))).toBeNull();
  });
});

describe('file, anti-doublon, contexte', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    resetAnalyticsStateForTests();
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    vi.stubGlobal('location', { origin: ORIGIN });
    vi.stubGlobal('document', { documentElement: { lang: 'en-GB', dataset: { rvTheme: 'light' } } });
  });

  afterEach(() => {
    resetAnalyticsStateForTests();
  });

  it('sans tracker : file d’attente, vidée au chargement', () => {
    vi.stubGlobal('window', {});
    trackAnalyticsEvent({ name: 'project_created', data: { source: 'blank' } });
    trackScreen('projects');
    const track = vi.fn();
    (window as { umami?: unknown }).umami = { track };
    flushAnalyticsQueue();
    expect(track).toHaveBeenCalledTimes(2);
    expect(track.mock.calls[0]).toEqual(['project_created', { source: 'blank' }]);
    const props = (track.mock.calls[1][0] as (p: Record<string, unknown>) => Record<string, unknown>)({ website: 'w', url: '/x', title: 'y' });
    expect(props).toEqual({ website: 'w', url: '/projets', title: 'Mes projets' });
  });

  it('mesure refusée sur l’appareil : rien ne part, ni en direct ni depuis la file', () => {
    vi.stubGlobal('window', {});
    trackAnalyticsEvent({ name: 'project_created', data: { source: 'blank' } });
    setAnalyticsOptOut(true);
    trackScreen('projects');
    const track = vi.fn();
    (window as { umami?: unknown }).umami = { track };
    trackAnalyticsEvent({ name: 'project_created', data: { source: 'import' } });
    flushAnalyticsQueue();
    expect(track).not.toHaveBeenCalled();
    expect(isAnalyticsOptedOut()).toBe(true);
    setAnalyticsOptOut(false);
    trackAnalyticsEvent({ name: 'theme_changed', data: { mode: 'dark' } });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('même événement dans la seconde : un seul envoi ; étranglement par clé', () => {
    const track = vi.fn();
    vi.stubGlobal('window', { umami: { track } });
    trackAnalyticsEvent({ name: 'freecam_entered' });
    trackAnalyticsEvent({ name: 'freecam_entered' });
    const routed = { name: 'route_calculated', data: { kind: 'patch', distance_km: 10, elevation_m: 100, ms: 300, surface: 'road', profile: 'custom' } } as const;
    trackAnalyticsEventThrottled(routed, 'route:a', 15_000);
    trackAnalyticsEventThrottled({ ...routed, data: { ...routed.data, distance_km: 20 } }, 'route:a', 15_000);
    trackAnalyticsEventThrottled({ ...routed, data: { ...routed.data, distance_km: 30 } }, 'route:b', 15_000);
    expect(track.mock.calls.map((call) => call[0])).toEqual(['freecam_entered', 'route_calculated', 'route_calculated']);
  });

  it('contexte : formule + ancienneté + langue + thème, persisté, effacé à la déconnexion', () => {
    setAnalyticsContext({ account_age: 'd0' });
    setAnalyticsContext({ plan: 'annual' });
    expect(getBeforeSendContext()).toMatchObject({
      superProps: { surface: 'app', plan: 'annual', account_age: 'd0', lang: 'en', theme: 'light' },
      excluded: false,
    });
    expect(JSON.parse(store.get('rv:analytics-context') ?? '{}')).toEqual({ account_age: 'd0', plan: 'annual' });
    setAnalyticsContext({ internal: true });
    expect(getBeforeSendContext().excluded).toBe(true);
    clearAnalyticsContext();
    expect(store.has('rv:analytics-context')).toBe(false);
    expect(getBeforeSendContext().superProps).toEqual({ surface: 'app', lang: 'en', theme: 'light' });
  });

  it('résumés de fermeture de page', () => {
    const summary = vi.fn();
    const unregister = registerAnalyticsPageHideSummary(summary);
    runAnalyticsPageHideSummaries();
    unregister();
    runAnalyticsPageHideSummaries();
    expect(summary).toHaveBeenCalledTimes(1);
  });
});

describe('attributs de clic et release', () => {
  it('analyticsAttrs', () => {
    expect(analyticsAttrs({ name: 'map_tool_selected', data: { tool: 'tracer' } })).toEqual({
      'data-umami-event': 'map_tool_selected',
      'data-umami-event-tool': 'tracer',
    });
  });

  it('tag de release court et propre', () => {
    expect(releaseTag('6efd1a8c0ffee1234567')).toBe('6efd1a8c0ffe');
    expect(releaseTag('dev local')).toBe('devlocal');
    expect(releaseTag('')).toBe('unknown');
  });
});

describe('libellés lisibles', () => {
  it('chaque événement a un nom affiché unique, ≤ 50 caractères (limite Umami)', () => {
    const labels = Object.values(EVENT_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(50);
  });

  it('noms de propriétés uniques ; chaque table de valeurs a son nom de propriété', () => {
    const shown = Object.values(PROPERTY_LABELS);
    expect(new Set(shown).size).toBe(shown.length);
    for (const key of Object.keys(VALUE_LABELS)) expect(PROPERTY_LABELS[key]).toBeDefined();
  });

  it('durées en secondes, booléens en oui / non, valeurs inconnues inchangées', () => {
    expect(toDisplayData({ ms: 3400, cold: true, itineraries: '2-5', kind: 'patch', category: 'inconnue' })).toEqual({
      'durée (secondes)': 3.4,
      'ouvert par un lien direct': 'oui',
      itinéraires: '2-5',
      'type de calcul': 'Retouche locale',
      catégorie: 'inconnue',
    });
  });
  it('plafond de la carte : chaque catégorie encore en chargement est traduite', () => {
    expect(toDisplayData({ capped: true, waiting: 'dem+poi' })).toEqual({
      'arrêtée au délai de 12 s': 'oui',
      'encore en chargement': 'Relief + POI',
    });
    expect(toDisplayData({ waiting: 'weather' })).toEqual({ 'encore en chargement': 'Météo' });
  });
});
