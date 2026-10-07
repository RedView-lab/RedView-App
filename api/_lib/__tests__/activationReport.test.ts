import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { computeActivation, computeUsage, formatActivationTable, formatPlainSummary, formatUsageReport, projectHasRoute, projectUsage } from '../activationReport.ts';

const NOW = Date.UTC(2026, 9, 7, 12); // mercredi 7 octobre 2026
const day = (offset: number) => new Date(NOW + offset * 24 * 60 * 60 * 1000).toISOString();

describe('rapport d’activation', () => {
  it('compte chaque étape par cohorte hebdomadaire et en total', () => {
    const users = [
      // Semaine du 28/09 : inscrite il y a 9 jours, projet tracé, revenue à J+8.
      { id: 'a', registeredAt: day(-9), accessedAt: day(-1) },
      // Semaine du 28/09 : projet vide, jamais revenu.
      { id: 'b', registeredAt: day(-8), accessedAt: day(-8) },
      // Semaine du 05/10 : trop récente pour le retour à J+7.
      { id: 'c', registeredAt: day(-1), accessedAt: day(0) },
    ];
    const projects = [
      { ownerId: 'a', updatedAt: day(-6), routed: true },
      { ownerId: 'b', updatedAt: day(-8), routed: false },
    ];
    const { cohorts, total } = computeActivation(users, projects, new Set(['a']), NOW);

    expect(cohorts.map((row) => row.cohort)).toEqual(['2026-10-05', '2026-09-28']);
    expect(cohorts[1]).toEqual({
      cohort: '2026-09-28', signups: 2, createdProject: 2, routedItinerary: 1, eligibleForReturn: 2, returnedAfter7d: 1, paid: 1,
    });
    expect(cohorts[0]).toMatchObject({ signups: 1, createdProject: 0, eligibleForReturn: 0, returnedAfter7d: 0 });
    expect(total).toMatchObject({ signups: 3, createdProject: 2, routedItinerary: 1, eligibleForReturn: 2, returnedAfter7d: 1, paid: 1 });
  });

  it('le retour à J+7 se lit aussi sur la dernière sauvegarde d’un projet', () => {
    const { total } = computeActivation(
      [{ id: 'a', registeredAt: day(-30), accessedAt: null }],
      [{ ownerId: 'a', updatedAt: day(-20), routed: false }],
      new Set(),
      NOW,
    );
    expect(total.returnedAfter7d).toBe(1);
  });

  it('reconnaît un itinéraire tracé dans chaque forme de document', () => {
    const routed = { itineraries: [{ gpxRoute: { points: [{ lat: 45, lon: 6 }, { lat: 45.1, lon: 6.1 }] } }] };
    const empty = { itineraries: [{ gpxRoute: { points: [] } }, {}] };
    expect(projectHasRoute(JSON.stringify(routed))).toBe(true);
    expect(projectHasRoute(`gz:${gzipSync(JSON.stringify(routed)).toString('base64')}`)).toBe(true);
    expect(projectHasRoute(JSON.stringify(empty))).toBe(false);
    expect(projectHasRoute('file:abc123')).toBe(true);
    expect(projectHasRoute('gz:pas-du-gzip')).toBe(false);
    expect(projectHasRoute(undefined)).toBe(false);
  });

  it('le tableau donne effectifs et taux, « — » sans dénominateur', () => {
    const table = formatActivationTable(computeActivation([{ id: 'c', registeredAt: day(-1) }], [], new Set(), NOW));
    expect(table).toContain('| 2026-10-05 | 1 | 0 (0 %) | 0 (0 %) | — | 0 (0 %) |');
    expect(table).toContain('| **Total** | 1 |');
  });
});

describe('rapport d’usage', () => {
  const point = (lat: number, lon: number) => ({ lat, lon });

  it('compte le contenu d’un document sans le recopier', () => {
    const document = {
      itineraries: [
        {
          gpxRoute: { points: [point(45, 6), point(45.1, 6)] },
          fitUploads: [{ name: 'a.fit' }, { name: 'b.fit' }],
          prediction: { totalSec: 3600 },
          forbiddenZones: [{ id: 'z' }],
          timeline: [{ kind: 'poi', favorite: true }, { kind: 'poi', favorite: false }, { kind: 'start' }],
        },
        { gpxRoute: { points: [] } },
      ],
      comments: [{ id: 't1' }],
      routingProfiles: [{ id: 'p1' }],
    };
    const usage = projectUsage(`gz:${gzipSync(JSON.stringify(document)).toString('base64')}`);
    expect(usage).toMatchObject({
      routed: true, itineraries: 2, routedItineraries: 1, fitFiles: 2, predictions: 1,
      comments: 1, poiFavorites: 1, forbiddenZones: 1, embeddedProfiles: 1,
    });
    expect(usage?.distanceKm).toBeCloseTo(11.12, 1);
    expect(projectUsage('file:abc')).toMatchObject({ routed: true, itineraries: 0 });
    expect(projectUsage('pas du json')).toBeNull();
  });

  it('agrège par compte : actifs, tranches, adoption', () => {
    const users = [
      { id: 'a', registeredAt: day(-40), accessedAt: day(-2), customProfiles: 2 },
      { id: 'b', registeredAt: day(-40), accessedAt: day(-20) },
      { id: 'c', registeredAt: day(-40), accessedAt: day(-90) },
    ];
    const usage = (patch: Partial<NonNullable<ReturnType<typeof projectUsage>>>) => ({
      routed: false, itineraries: 0, routedItineraries: 0, distanceKm: 0, fitFiles: 0,
      predictions: 0, comments: 0, poiFavorites: 0, forbiddenZones: 0, embeddedProfiles: 0, ...patch,
    });
    const projects = [
      { ownerId: 'a', updatedAt: day(-2), routed: true, shared: true, usage: usage({ routed: true, itineraries: 3, routedItineraries: 2, distanceKm: 640, comments: 2 }) },
      { ownerId: 'a', updatedAt: day(-5), routed: false, usage: usage({ itineraries: 1, fitFiles: 1 }) },
      { ownerId: 'b', updatedAt: day(-20), routed: true, usage: usage({ routed: true, itineraries: 1, routedItineraries: 1, distanceKm: 42 }) },
    ];
    const report = computeUsage(users, projects, NOW);
    expect(report).toMatchObject({
      accounts: 3,
      activeLast7d: 1,
      activeLast30d: 2,
      projectsPerAccount: { '2-5': 1, '1': 1, '0': 1 },
      itinerariesPerAccount: { '2-5': 1, '1': 1, '0': 1 },
      kmPerAccount: { '500-2000': 1, '<100': 1, '0': 1 },
      totals: { projects: 3, itineraries: 5, routedItineraries: 3, km: 682 },
    });
    expect(report.adoption).toEqual({
      routed: 2, multiItinerary: 1, shared: 1, comments: 1, fit: 1, prediction: 0, poiFavorites: 0, forbiddenZones: 0, customProfiles: 1,
    });
    const text = formatUsageReport(report);
    expect(text).toContain('| Projet partagé (co-édition) | 1 | 33 % |');
    expect(text).toContain('682 km planifiés');
  });
});

describe('synthèse en phrases', () => {
  it('ramène chaque étape à 10 inscrits et nomme la plus grosse perte', () => {
    const users = [
      { id: 'a', registeredAt: day(-20), accessedAt: day(-1) },
      { id: 'b', registeredAt: day(-20), accessedAt: day(-20) },
      { id: 'c', registeredAt: day(-20), accessedAt: day(-20) },
      { id: 'd', registeredAt: day(-20), accessedAt: day(-20) },
    ];
    const projects = ['a', 'b', 'c', 'd'].map((ownerId) => ({ ownerId, updatedAt: day(-20), routed: ownerId === 'a' }));
    const text = formatPlainSummary(computeActivation(users, projects, new Set(), NOW), computeUsage(users, projects, NOW));
    expect(text).toContain('Sur 10 inscrits, 10 créent un projet et 3 tracent un itinéraire.');
    expect(text).toContain('Plus grosse perte : entre le premier projet et le premier itinéraire tracé (3 comptes s’arrêtent là).');
    expect(text).toContain('Sur 10 inscrits depuis plus d’une semaine, 3 sont revenus');
    expect(text).toContain('Jamais utilisées :');
  });
});
