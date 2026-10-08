/**
 * Données des comptes de test du banc de charge : projets « Charge · … » et
 * salles de co-édition, en production, faits des documents que l'app a
 * elle-même écrits pendant le calibrage (calibrate.mjs → fixtures/project-calibration.json :
 * 3 itinéraires routés de 30, 150 et 550 km).
 *
 * Trois tailles, comme les projets réels : petit (l'itinéraire de 30 km),
 * moyen (30 + 150 km), gros (les trois). Les lignes sont créées par la clé
 * d'administration avec la forme et les permissions de `createProject`
 * (src/shared/services/projects/projectRows.ts) ; les salles passent par le
 * vrai `inviteToProject` (api/_lib/projectSharing.ts). Idempotent : une
 * seconde passe réutilise ce qui existe. `accounts.ts teardown` purge tout.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ID, Permission, Query, Role } from 'node-appwrite';

import { APPWRITE_DATABASE_ID, getAppwriteDatabases } from '../../api/_lib/appwrite.ts';
import type { LoadTestSession } from './accounts.ts';

export const FIXTURE_FILE = path.join(import.meta.dirname, '..', 'reports', 'vps-load', 'fixtures', 'project-calibration.json');
const PROJECTS = 'projects';
const OWN_PREFIX = 'Charge · projet';
const ROOM_PREFIX = 'Charge · salle';

export type FixtureSize = 'petit' | 'moyen' | 'gros';

export interface FixturePayload {
  size: FixtureSize;
  /** Champ `data` tel que l'app l'écrit (`gz:` + base64 du gzip du document). */
  data: string;
  sizeBytes: number;
  document: ProjectDocumentJson;
}

export interface ProjectDocumentJson {
  schema: 2;
  name: string;
  itineraries: Array<{ id: string; gpxRoute?: { points?: Array<Record<string, unknown>> } } & Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OwnProject {
  id: string;
  size: FixtureSize;
}

export interface Room {
  projectId: string;
  ownerIndex: number;
  memberIndexes: number[];
  /** Itinéraire dont les membres modifient le tracé (lots de morceaux de route). */
  itineraryId: string;
}

export interface FixturePlan {
  /** Par index de compte : ses projets (le premier est celui qu'il ouvre). */
  own: Record<number, OwnProject[]>;
  rooms: Room[];
}

export function encodePayload(document: ProjectDocumentJson): { data: string; sizeBytes: number } {
  const json = JSON.stringify(document);
  return { data: `gz:${gzipSync(json).toString('base64')}`, sizeBytes: Buffer.byteLength(json) };
}

/**
 * Document sans la seconde copie des tracés : `gpxRoute.originalPoints`
 * identique à `points` remplacé par une marque (piste « compaction » de la
 * sauvegarde, à mesurer en A/B : seule la taille de la charge compte ici).
 */
function compactDocument(document: ProjectDocumentJson): ProjectDocumentJson {
  return {
    ...document,
    itineraries: document.itineraries.map((itinerary) => {
      const route = itinerary.gpxRoute as ({ points?: unknown; originalPoints?: unknown } & Record<string, unknown>) | undefined;
      if (!route || JSON.stringify(route.originalPoints) !== JSON.stringify(route.points)) return itinerary;
      const { originalPoints: _duplicate, ...rest } = route;
      return { ...itinerary, gpxRoute: { ...rest, originalPointsSameAsPoints: true } } as ProjectDocumentJson['itineraries'][number];
    }),
  };
}

/** Les trois tailles de projet tirées du document de calibrage (`compacte` : sans la copie des tracés). */
export function loadFixturePayloads(variant: 'actuelle' | 'compacte' = 'actuelle'): Record<FixtureSize, FixturePayload> {
  if (!existsSync(FIXTURE_FILE)) throw new Error(`fixture absente : lancer d'abord calibrate.mjs (${FIXTURE_FILE})`);
  const raw = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as { data: string };
  const full = JSON.parse(gunzipSync(Buffer.from(raw.data.slice(3), 'base64')).toString('utf8')) as ProjectDocumentJson;
  if (full.itineraries.length < 3) throw new Error('fixture : 3 itinéraires attendus');
  const base = variant === 'compacte' ? compactDocument(full) : full;
  const variantOf = (size: FixtureSize, count: number): FixturePayload => {
    const document = { ...base, name: `Charge ${size}`, itineraries: base.itineraries.slice(0, count) };
    return { size, document, ...encodePayload(document) };
  };
  return { petit: variantOf('petit', 1), moyen: variantOf('moyen', 2), gros: variantOf('gros', 3) };
}

/** Taille du projet qu'ouvre le compte `index` : 60 % petits, 30 % moyens, 10 % gros (déterministe). */
export function activeSizeFor(index: number): FixtureSize {
  const bucket = index % 10;
  return bucket === 9 ? 'gros' : bucket >= 6 ? 'moyen' : 'petit';
}

async function listOwnRows(userId: string, prefix: string) {
  const rows = await getAppwriteDatabases().listDocuments(APPWRITE_DATABASE_ID, PROJECTS, [
    Query.equal('user_id', userId),
    Query.startsWith('name', prefix),
    Query.select(['$id', 'name', 'team_id']),
    Query.limit(100),
  ]);
  return rows.documents as unknown as Array<{ $id: string; name: string; team_id?: string | null }>;
}

async function createRow(userId: string, name: string, payload: FixturePayload): Promise<string> {
  const doc = await getAppwriteDatabases().createDocument(
    APPWRITE_DATABASE_ID,
    PROJECTS,
    ID.unique(),
    { user_id: userId, folder_id: null, name, data: payload.data, size_bytes: payload.sizeBytes, privacy: 'private' },
    [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
  );
  return doc.$id;
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await Promise.all(items.slice(start, start + size).map(run));
}

/**
 * Prépare 3 projets par compte (celui qu'il ouvre d'abord est de la taille
 * `activeSizeFor`) et `roomCount` salles de `roomSize` comptes pris parmi
 * `collabIndexes` (le premier de chaque salle en est le propriétaire).
 */
export async function prepareFixtures(
  sessions: LoadTestSession[],
  payloads: Record<FixtureSize, FixturePayload>,
  collabIndexes: number[],
  roomSize: number,
  log: (line: string) => void,
): Promise<FixturePlan> {
  const plan: FixturePlan = { own: {}, rooms: [] };
  const byIndex = new Map(sessions.map((session) => [session.index, session]));
  await inBatches(sessions, 6, async (session) => {
    const existing = await listOwnRows(session.userId, OWN_PREFIX);
    const wanted: FixtureSize[] = [activeSizeFor(session.index), 'petit', 'moyen'];
    const projects: OwnProject[] = [];
    for (let slot = 0; slot < wanted.length; slot += 1) {
      const name = `${OWN_PREFIX} ${slot + 1} (${wanted[slot]})`;
      const found = existing.find((row) => row.name === name);
      projects.push({ id: found?.$id ?? await createRow(session.userId, name, payloads[wanted[slot]!]), size: wanted[slot]! });
    }
    plan.own[session.index] = projects;
  });
  log(`projets prêts : ${sessions.length} comptes × 3`);

  const { inviteToProject } = await import('../../api/_lib/projectSharing.ts');
  const groups: number[][] = [];
  for (let start = 0; start + 1 < collabIndexes.length; start += roomSize) groups.push(collabIndexes.slice(start, start + roomSize));
  // Le salon de la fin, trop petit, rejoint le précédent.
  if (groups.length > 1 && groups[groups.length - 1]!.length < 2) groups[groups.length - 2]!.push(...groups.pop()!);
  const roomItinerary = payloads.moyen.document.itineraries[1]!.id;
  await inBatches(groups, 4, async (group) => {
    const owner = byIndex.get(group[0]!)!;
    const name = `${ROOM_PREFIX} ${String(owner.index).padStart(3, '0')}`;
    const existing = (await listOwnRows(owner.userId, ROOM_PREFIX)).find((row) => row.name === name);
    const projectId = existing?.$id ?? await createRow(owner.userId, name, payloads.moyen);
    for (const memberIndex of group.slice(1)) {
      const member = byIndex.get(memberIndex)!;
      await inviteToProject({ id: owner.userId, email: owner.email }, projectId, member.email);
    }
    plan.rooms.push({ projectId, ownerIndex: owner.index, memberIndexes: group, itineraryId: roomItinerary });
  });
  plan.rooms.sort((a, b) => a.ownerIndex - b.ownerIndex);
  log(`salles de co-édition prêtes : ${plan.rooms.length} (${collabIndexes.length} comptes)`);
  return plan;
}
