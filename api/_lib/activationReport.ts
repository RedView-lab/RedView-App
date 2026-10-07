import { gunzipSync } from 'node:zlib';

import { Query, type Models } from 'node-appwrite';

import { corroboratedOwnerId } from '../../server/lib/project-access.mjs';
import {
  APPWRITE_DATABASE_ID,
  getAppwriteDatabases,
  getAppwriteUsers,
  PROJECTS_COLLECTION_ID,
  SUBSCRIPTIONS_COLLECTION_ID,
} from './appwrite.js';

/**
 * Activation par cohorte d'inscription, calculée depuis la base (la source
 * de vérité) plutôt qu'en suivant les personnes dans l'outil d'audience :
 * Umami reste anonyme (src/shared/lib/analytics/, docs/analytics/measurement.md), ce rapport ne sort que
 * des agrégats. Lancé à la main : scripts/analytics/activation-report.ts.
 *
 * Étapes, par compte :
 *  1. inscrit (cohorte = semaine ISO de l'inscription, lundi UTC) ;
 *  2. a créé un projet (propriétaire établi par les permissions de la ligne) ;
 *  3. a un itinéraire tracé (un tracé d'au moins 2 points dans un de ses projets) ;
 *  4. est revenu au moins 7 jours après son inscription (dernière activité
 *     du compte — `accessedAt` d'Appwrite — ou dernière sauvegarde d'un de
 *     ses projets) ; mesuré seulement pour les inscrits d'il y a 7 jours ou plus ;
 *  5. a un abonnement actif (essai et « à vie » compris).
 *
 * Usage (`--usage`) : actifs à 7 / 30 jours, répartition des projets,
 * itinéraires et kilomètres planifiés par compte (tranches), et part des
 * comptes qui utilisent chaque fonction (partage, commentaires, FIT,
 * prédiction, favoris POI, zones interdites, profils de routage). Lu dans les
 * documents eux-mêmes, en agrégats ; les comptes libellés `internal` (équipe,
 * tests) sont écartés comme dans la mesure d'audience.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_AFTER_DAYS = 7;
const PAID_STATUSES = new Set(['active', 'trialing', 'lifetime']);
/** Libellé Appwrite des comptes de l'équipe et de test (aussi exclus de la mesure d'audience, src/features/auth/lib/authAnalytics.ts). */
export const INTERNAL_ACCOUNT_LABEL = 'internal';

export interface ActivationUser {
  id: string;
  registeredAt: string;
  accessedAt?: string | null;
  /** Profils de routage de la bibliothèque du compte (`prefs.routingProfiles`). */
  customProfiles?: number;
}

export interface ActivationProject {
  ownerId: string;
  updatedAt: string;
  routed: boolean;
  /** Partagé avec une équipe (permission `team:` sur la ligne). */
  shared?: boolean;
  usage?: ProjectUsage | null;
}

/** Ce qu'un document de projet contient (compté, jamais recopié). */
export interface ProjectUsage {
  routed: boolean;
  itineraries: number;
  routedItineraries: number;
  distanceKm: number;
  fitFiles: number;
  predictions: number;
  comments: number;
  poiFavorites: number;
  forbiddenZones: number;
  embeddedProfiles: number;
}

export interface CohortRow {
  /** Lundi (UTC) de la semaine d'inscription, AAAA-MM-JJ ; « total » pour la ligne d'ensemble. */
  cohort: string;
  signups: number;
  createdProject: number;
  routedItinerary: number;
  /** Inscrits depuis au moins 7 jours : dénominateur du retour à J+7. */
  eligibleForReturn: number;
  returnedAfter7d: number;
  paid: number;
}

function weekStart(iso: string): string {
  const date = new Date(iso);
  const day = (date.getUTCDay() + 6) % 7; // lundi = 0
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function emptyRow(cohort: string): CohortRow {
  return { cohort, signups: 0, createdProject: 0, routedItinerary: 0, eligibleForReturn: 0, returnedAfter7d: 0, paid: 0 };
}

/** Agrégation pure (testée) : cohortes de la plus récente à la plus ancienne, puis le total. */
export function computeActivation(
  users: readonly ActivationUser[],
  projects: readonly ActivationProject[],
  paidUserIds: ReadonlySet<string>,
  now = Date.now(),
): { cohorts: CohortRow[]; total: CohortRow } {
  const byOwner = new Map<string, ActivationProject[]>();
  for (const project of projects) {
    const list = byOwner.get(project.ownerId) ?? [];
    list.push(project);
    byOwner.set(project.ownerId, list);
  }
  const cohorts = new Map<string, CohortRow>();
  const total = emptyRow('total');
  for (const user of users) {
    const registered = Date.parse(user.registeredAt);
    if (!Number.isFinite(registered)) continue;
    const key = weekStart(user.registeredAt);
    const row = cohorts.get(key) ?? emptyRow(key);
    cohorts.set(key, row);
    const owned = byOwner.get(user.id) ?? [];
    const lastActivity = Math.max(
      user.accessedAt ? Date.parse(user.accessedAt) || 0 : 0,
      ...owned.map((project) => Date.parse(project.updatedAt) || 0),
    );
    const eligible = now - registered >= RETURN_AFTER_DAYS * DAY_MS;
    for (const target of [row, total]) {
      target.signups += 1;
      if (owned.length > 0) target.createdProject += 1;
      if (owned.some((project) => project.routed)) target.routedItinerary += 1;
      if (eligible) {
        target.eligibleForReturn += 1;
        if (lastActivity - registered >= RETURN_AFTER_DAYS * DAY_MS) target.returnedAfter7d += 1;
      }
      if (paidUserIds.has(user.id)) target.paid += 1;
    }
  }
  return { cohorts: [...cohorts.values()].sort((a, b) => b.cohort.localeCompare(a.cohort)), total };
}

const EMPTY_USAGE: ProjectUsage = {
  routed: false, itineraries: 0, routedItineraries: 0, distanceKm: 0, fitFiles: 0,
  predictions: 0, comments: 0, poiFavorites: 0, forbiddenZones: 0, embeddedProfiles: 0,
};

function haversineKm(a: { lat?: unknown; lon?: unknown }, b: { lat?: unknown; lon?: unknown }): number {
  const [lat1, lon1, lat2, lon2] = [a.lat, a.lon, b.lat, b.lon].map(Number);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const arrayLength = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * Contenu d'un document de projet, compté. `file:` (gros projet stocké dans
 * le bucket) : tracé supposé, le reste inconnu (0). Illisible : `null`.
 */
export function projectUsage(data: unknown): ProjectUsage | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  if (data.startsWith('file:')) return { ...EMPTY_USAGE, routed: true };
  let document: unknown;
  try {
    document = data.startsWith('gz:')
      ? JSON.parse(gunzipSync(Buffer.from(data.slice(3), 'base64'), { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'))
      : JSON.parse(data);
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object') return null;
  const root = document as { itineraries?: unknown; comments?: unknown; routingProfiles?: unknown };
  const usage: ProjectUsage = { ...EMPTY_USAGE, comments: arrayLength(root.comments), embeddedProfiles: arrayLength(root.routingProfiles) };
  for (const raw of Array.isArray(root.itineraries) ? root.itineraries : []) {
    if (!raw || typeof raw !== 'object') continue;
    const itinerary = raw as {
      gpxRoute?: { points?: unknown };
      fitUploads?: unknown;
      prediction?: unknown;
      timeline?: unknown;
      forbiddenZones?: unknown;
    };
    usage.itineraries += 1;
    const points = itinerary.gpxRoute?.points;
    if (Array.isArray(points) && points.length >= 2) {
      usage.routed = true;
      usage.routedItineraries += 1;
      for (let index = 1; index < points.length; index += 1) {
        usage.distanceKm += haversineKm(points[index - 1] ?? {}, points[index] ?? {});
      }
    }
    usage.fitFiles += arrayLength(itinerary.fitUploads);
    if (itinerary.prediction && typeof itinerary.prediction === 'object') usage.predictions += 1;
    usage.forbiddenZones += arrayLength(itinerary.forbiddenZones);
    if (Array.isArray(itinerary.timeline)) {
      usage.poiFavorites += itinerary.timeline.filter((row) => {
        const item = row as { kind?: unknown; favorite?: unknown } | null;
        return item?.kind === 'poi' && item.favorite === true;
      }).length;
    }
  }
  return usage;
}

/** Le document contient-il un itinéraire tracé ? Charge utile en fichier (gros projet) : oui. */
export function projectHasRoute(data: unknown): boolean {
  return projectUsage(data)?.routed ?? false;
}

export interface UsageReport {
  accounts: number;
  activeLast7d: number;
  activeLast30d: number;
  /** Tranche → nombre de comptes. */
  projectsPerAccount: Record<string, number>;
  itinerariesPerAccount: Record<string, number>;
  kmPerAccount: Record<string, number>;
  /** Comptes qui utilisent chaque fonction (au moins une fois dans leurs projets). */
  adoption: Record<UsageFeature, number>;
  totals: { projects: number; itineraries: number; routedItineraries: number; km: number };
}

type UsageFeature =
  | 'routed'
  | 'multiItinerary'
  | 'shared'
  | 'comments'
  | 'fit'
  | 'prediction'
  | 'poiFavorites'
  | 'forbiddenZones'
  | 'customProfiles';

function countTier(count: number): string {
  if (count <= 1) return String(Math.max(0, count));
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '>20';
}

function kmTier(km: number): string {
  if (km <= 0) return '0';
  if (km < 100) return '<100';
  if (km < 500) return '100-500';
  if (km < 2000) return '500-2000';
  return '>2000';
}

/** Usage par compte, en agrégats (pure, testée). */
export function computeUsage(
  users: readonly ActivationUser[],
  projects: readonly ActivationProject[],
  now = Date.now(),
): UsageReport {
  const byOwner = new Map<string, ActivationProject[]>();
  for (const project of projects) {
    const list = byOwner.get(project.ownerId) ?? [];
    list.push(project);
    byOwner.set(project.ownerId, list);
  }
  const bump = (record: Record<string, number>, key: string) => {
    record[key] = (record[key] ?? 0) + 1;
  };
  const report: UsageReport = {
    accounts: users.length,
    activeLast7d: 0,
    activeLast30d: 0,
    projectsPerAccount: {},
    itinerariesPerAccount: {},
    kmPerAccount: {},
    adoption: { routed: 0, multiItinerary: 0, shared: 0, comments: 0, fit: 0, prediction: 0, poiFavorites: 0, forbiddenZones: 0, customProfiles: 0 },
    totals: { projects: 0, itineraries: 0, routedItineraries: 0, km: 0 },
  };
  for (const user of users) {
    const owned = byOwner.get(user.id) ?? [];
    const lastActivity = Math.max(
      user.accessedAt ? Date.parse(user.accessedAt) || 0 : 0,
      ...owned.map((project) => Date.parse(project.updatedAt) || 0),
    );
    if (now - lastActivity <= 7 * DAY_MS) report.activeLast7d += 1;
    if (now - lastActivity <= 30 * DAY_MS) report.activeLast30d += 1;
    let itineraries = 0;
    let km = 0;
    const used = new Set<UsageFeature>();
    for (const project of owned) {
      if (project.shared) used.add('shared');
      if (project.routed) used.add('routed');
      const usage = project.usage;
      if (!usage) continue;
      itineraries += usage.itineraries;
      km += usage.distanceKm;
      report.totals.itineraries += usage.itineraries;
      report.totals.routedItineraries += usage.routedItineraries;
      if (usage.itineraries > 1) used.add('multiItinerary');
      if (usage.comments > 0) used.add('comments');
      if (usage.fitFiles > 0) used.add('fit');
      if (usage.predictions > 0) used.add('prediction');
      if (usage.poiFavorites > 0) used.add('poiFavorites');
      if (usage.forbiddenZones > 0) used.add('forbiddenZones');
    }
    if ((user.customProfiles ?? 0) > 0) used.add('customProfiles');
    report.totals.projects += owned.length;
    report.totals.km += km;
    bump(report.projectsPerAccount, countTier(owned.length));
    bump(report.itinerariesPerAccount, countTier(itineraries));
    bump(report.kmPerAccount, kmTier(km));
    for (const feature of used) report.adoption[feature] += 1;
  }
  report.totals.km = Math.round(report.totals.km);
  return report;
}

const USAGE_FEATURE_LABELS: Record<UsageFeature, string> = {
  routed: 'Au moins un itinéraire tracé',
  multiItinerary: 'Plusieurs variantes dans un projet',
  shared: 'Projet partagé (co-édition)',
  comments: 'Commentaires',
  fit: 'Fichiers FIT importés',
  prediction: 'Prédiction de temps calculée',
  poiFavorites: 'POI en favori (pauses)',
  forbiddenZones: 'Zones interdites',
  customProfiles: 'Profils de routage personnalisés',
};

/** Rapport d'usage en Markdown. */
export function formatUsageReport(report: UsageReport): string {
  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—');
  const tiers = (record: Record<string, number>, order: string[]) =>
    order.filter((key) => record[key]).map((key) => `${key} : ${record[key]}`).join(' · ') || '—';
  return [
    `**Comptes** ${report.accounts} — actifs 7 j : ${report.activeLast7d} (${share(report.activeLast7d, report.accounts)}), 30 j : ${report.activeLast30d} (${share(report.activeLast30d, report.accounts)})`,
    `**Volume** ${report.totals.projects} projets, ${report.totals.itineraries} itinéraires (${report.totals.routedItineraries} tracés), ${report.totals.km} km planifiés`,
    '',
    `Projets par compte : ${tiers(report.projectsPerAccount, ['0', '1', '2-5', '6-20', '>20'])}`,
    `Itinéraires par compte : ${tiers(report.itinerariesPerAccount, ['0', '1', '2-5', '6-20', '>20'])}`,
    `Kilomètres planifiés par compte : ${tiers(report.kmPerAccount, ['0', '<100', '100-500', '500-2000', '>2000'])}`,
    '',
    '| Fonction | Comptes | Part |',
    '|---|---:|---:|',
    ...(Object.keys(USAGE_FEATURE_LABELS) as UsageFeature[]).map(
      (feature) => `| ${USAGE_FEATURE_LABELS[feature]} | ${report.adoption[feature]} | ${share(report.adoption[feature], report.accounts)} |`,
    ),
  ].join('\n');
}

/**
 * Lit comptes, projets et abonnements (clé admin, lecture seule). Écartés :
 * les comptes libellés `internal` et, avec `exclude`, ceux dont l'e-mail
 * correspond (filtré en mémoire, jamais affiché).
 */
export async function loadActivationData(exclude?: RegExp): Promise<{
  users: ActivationUser[];
  projects: ActivationProject[];
  paidUserIds: Set<string>;
  excluded: number;
}> {
  const users: ActivationUser[] = [];
  const excludedIds = new Set<string>();
  for (let cursor: string | null = null; ;) {
    const page: Models.UserList<Models.Preferences> = await getAppwriteUsers().list([Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])]);
    for (const user of page.users) {
      if (exclude?.test(user.email ?? '') || (user.labels ?? []).includes(INTERNAL_ACCOUNT_LABEL)) {
        excludedIds.add(user.$id);
        continue;
      }
      const routingProfiles = (user.prefs as { routingProfiles?: unknown } | undefined)?.routingProfiles;
      users.push({
        id: user.$id,
        registeredAt: user.registration || user.$createdAt,
        accessedAt: user.accessedAt || null,
        customProfiles: Array.isArray(routingProfiles) ? routingProfiles.length : 0,
      });
    }
    if (page.users.length < 100) break;
    cursor = page.users[page.users.length - 1].$id;
  }

  const databases = getAppwriteDatabases();
  const projects: ActivationProject[] = [];
  // Pages courtes : chaque ligne porte son document (jusqu'à 12 M car.).
  for (let cursor: string | null = null; ;) {
    const page: Models.DocumentList<Models.Document> = await databases.listDocuments(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, [
      Query.select(['$id', '$permissions', '$updatedAt', 'user_id', 'data']),
      Query.limit(10),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ]);
    for (const doc of page.documents) {
      const ownerId = corroboratedOwnerId(doc as unknown as { user_id?: unknown; $permissions?: string[] });
      if (!ownerId || excludedIds.has(ownerId)) continue;
      const usage = projectUsage((doc as { data?: unknown }).data);
      const shared = (doc.$permissions ?? []).some((permission) => permission.includes('"team:'));
      projects.push({ ownerId, updatedAt: doc.$updatedAt, routed: usage?.routed ?? false, shared, usage });
    }
    if (page.documents.length < 10) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }

  const paidUserIds = new Set<string>();
  for (let cursor: string | null = null; ;) {
    let page: Models.DocumentList<Models.Document>;
    try {
      page = await databases.listDocuments(APPWRITE_DATABASE_ID, SUBSCRIPTIONS_COLLECTION_ID, [
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ]);
    } catch (error) {
      if ((error as { code?: unknown }).code === 404) break;
      throw error;
    }
    for (const doc of page.documents) {
      const row = doc as unknown as { user_id?: string; status?: string };
      if (row.user_id && PAID_STATUSES.has(row.status ?? '')) paidUserIds.add(row.user_id);
    }
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }

  return { users, projects, paidUserIds, excluded: excludedIds.size };
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—');

/** Part ramenée à 10 personnes (« 8 » sur 10), lisible sans pourcentage. */
function outOfTen(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 10) : 0;
}

/**
 * Synthèse en phrases simples (pour quelqu'un qui ne lit pas les tableaux) :
 * l'entonnoir d'activation du total, la dernière cohorte complète et, avec
 * l'usage, l'activité récente et les fonctions les plus et les moins utilisées.
 */
export function formatPlainSummary(
  { cohorts, total }: { cohorts: CohortRow[]; total: CohortRow },
  usage?: UsageReport | null,
): string {
  const lines: string[] = ['## En bref', ''];
  if (total.signups === 0) return [...lines, 'Aucun compte sur la période.'].join('\n');
  lines.push(`• ${total.signups} comptes au total. Sur 10 inscrits, ${outOfTen(total.createdProject, total.signups)} créent un projet `
    + `et ${outOfTen(total.routedItinerary, total.signups)} tracent un itinéraire.`);
  if (total.eligibleForReturn > 0) {
    lines.push(`• Sur 10 inscrits depuis plus d’une semaine, ${outOfTen(total.returnedAfter7d, total.eligibleForReturn)} sont revenus après leur première semaine.`);
  }
  const steps: Array<[string, number, number]> = [
    ['entre l’inscription et le premier projet', total.signups, total.createdProject],
    ['entre le premier projet et le premier itinéraire tracé', total.createdProject, total.routedItinerary],
  ];
  const worst = steps
    .filter(([, from]) => from > 0)
    .map(([label, from, to]) => ({ label, lost: from - to, share: (from - to) / from }))
    .sort((a, b) => b.share - a.share)[0];
  if (worst && worst.lost > 0) lines.push(`• Plus grosse perte : ${worst.label} (${worst.lost} compte${worst.lost > 1 ? 's' : ''} s’arrête${worst.lost > 1 ? 'nt' : ''} là).`);
  const latest = cohorts.find((row) => row.cohort !== 'total');
  if (latest) lines.push(`• Semaine du ${latest.cohort} : ${latest.signups} inscription${latest.signups > 1 ? 's' : ''}, ${latest.routedItinerary} avec un itinéraire tracé.`);
  if (total.paid === 0) lines.push('• Aucun abonnement payant pour l’instant (paiement pas encore ouvert).');
  if (usage) {
    lines.push(`• Actifs : ${usage.activeLast7d} compte${usage.activeLast7d > 1 ? 's' : ''} sur 7 jours, ${usage.activeLast30d} sur 30 jours. ${usage.totals.km} km planifiés au total.`);
    const ranked = (Object.keys(USAGE_FEATURE_LABELS) as UsageFeature[])
      .filter((feature) => feature !== 'routed')
      .map((feature) => ({ label: USAGE_FEATURE_LABELS[feature].toLowerCase(), count: usage.adoption[feature] }))
      .sort((a, b) => b.count - a.count);
    const top = ranked.slice(0, 2).filter((item) => item.count > 0);
    const unused = ranked.filter((item) => item.count === 0);
    if (top.length > 0) lines.push(`• Fonctions les plus utilisées : ${top.map((item) => `${item.label} (${item.count} compte${item.count > 1 ? 's' : ''})`).join(', ')}.`);
    if (unused.length > 0) lines.push(`• Jamais utilisées : ${unused.map((item) => item.label).join(', ')}.`);
  }
  return lines.join('\n');
}

/** Tableau Markdown : effectifs et taux de chaque étape par rapport aux inscrits. */
export function formatActivationTable({ cohorts, total }: { cohorts: CohortRow[]; total: CohortRow }): string {
  const header = '| Cohorte (semaine du) | Inscrits | Projet créé | Itinéraire tracé | Revenus après J+7 | Payants |\n|---|---:|---:|---:|---:|---:|';
  const line = (row: CohortRow) => `| ${row.cohort === 'total' ? '**Total**' : row.cohort} | ${row.signups} `
    + `| ${row.createdProject} (${pct(row.createdProject, row.signups)}) `
    + `| ${row.routedItinerary} (${pct(row.routedItinerary, row.signups)}) `
    + `| ${row.eligibleForReturn ? `${row.returnedAfter7d}/${row.eligibleForReturn} (${pct(row.returnedAfter7d, row.eligibleForReturn)})` : '—'} `
    + `| ${row.paid} (${pct(row.paid, row.signups)}) |`;
  return [header, ...cohorts.map(line), line(total)].join('\n');
}
