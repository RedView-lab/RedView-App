/**
 * Audit (et mise en conformité) des projets partagés en production.
 *
 *   npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts               # lecture seule : rapport
 *   npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts --apply       # corrige ce qui est sûr
 *   npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts --check-documents [--all]
 *   npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts --check-fit   # .fit : lecture seule
 *   npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts --grant-fit   # .fit : ouvre ce qui est sûr
 *
 * Rapport (ids seulement, jamais de contenu) :
 *  - lignes partagées dont les permissions ne sont pas canoniques
 *    (server/lib/project-access.mjs : lecture/écriture/suppression au
 *    propriétaire, LECTURE seule à l'équipe `p<projet>`) — l'ancien format
 *    donnait l'écriture à l'équipe : tout éditeur pouvait réécrire `user_id`,
 *    `team_id`, `data` et les permissions ;
 *  - `user_id` non corroboré par une permission, ou différent du membre
 *    `owner` de l'équipe (signe d'une réécriture par un éditeur) ;
 *  - lignes lisibles par `any` / `users` (jamais posé par l'application) ;
 *  - lignes que le nouveau filtre du client masquerait à leur propriétaire
 *    (aucune permission sur `user:<user_id>`) ;
 *  - équipes `p<projet>` sans projet partagé correspondant (squat ou partage
 *    interrompu), ou avec des propriétaires inattendus.
 *
 * `--apply` (seulement ce qui est sûr) : permissions canoniques et `team_id`
 * canonique des lignes partagées au propriétaire cohérent ; suppression des
 * équipes `p<projet>` qui n'ouvrent aucun projet (la ligne ne leur donne
 * rien). Les cas ambigus sont laissés à relire à la main.
 *
 * `--check-documents` : chaque document partagé (`--all` : chaque projet), rejoué en opérations
 * (collab/model/diff.ts), passe-t-il la validation du serveur temps réel
 * (collab/model/validate.ts) ? Un refus serait un lot honnête perdu.
 *
 * `--check-fit` : les .fit référencés par chaque document partagé sont-ils
 * lisibles par l'équipe ? Jusqu'à d6b67443, un .fit envoyé hors session
 * temps réel (serveur injoignable, session en cours d'ouverture) ne l'était
 * pas, et les éditeurs recevaient un 404. `--grant-fit` (indépendant de
 * `--apply`) l'accorde seulement quand c'est sûr : auteur du fichier membre de
 * l'équipe ET fichier créé après le partage (création de l'équipe) — un
 * éditeur ne peut pas faire ouvrir le fichier d'un autre compte, ni un
 * fichier antérieur au partage, en glissant son id dans le document. Le reste
 * est listé à relire.
 */
import { gunzipSync } from 'node:zlib';

import { Client, Databases, Query, Storage, Teams, type Models } from 'node-appwrite';

import {
  canonicalSharedPermissions,
  corroboratedOwnerId,
  grantsTeamWrite,
  isTeamShared,
  projectTeamId,
  samePermissions,
} from '../../server/lib/project-access.mjs';
import { documentOps } from '../../src/features/collab/model/diff.ts';
import { ObjectStore } from '../../src/features/collab/model/objects.ts';
import { checkBatch } from '../../src/features/collab/model/validate.ts';
import { readStoredProject } from '../../src/features/itineraryPanel/lib/project/layers.ts';

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';
const APPLY = process.argv.includes('--apply');
const CHECK_DOCUMENTS = process.argv.includes('--check-documents');
const CHECK_ALL = process.argv.includes('--all');
const GRANT_FIT = process.argv.includes('--grant-fit');
const CHECK_FIT = GRANT_FIT || process.argv.includes('--check-fit');
const FIT_BUCKET_ID = 'itinerary-fit-files';

if (!API_KEY) {
  console.error('APPWRITE_API_KEY manquant (lancer avec --env-file=.env).');
  process.exit(1);
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const teams = new Teams(client);
const storage = new Storage(client);

interface Row {
  $id: string;
  $permissions: string[];
  user_id?: string;
  team_id?: string | null;
  data?: unknown;
}

async function listAll<T extends { $id: string }>(fetchPage: (queries: string[]) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage([Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])]);
    all.push(...page);
    if (page.length < 100) return all;
    cursor = page[page.length - 1].$id;
  }
}

const listRows = (collection: string, select: string[]) => listAll<Row>(async (queries) =>
  (await databases.listDocuments(DATABASE_ID, collection, [...queries, Query.select(select)])).documents as unknown as Row[]);

async function memberships(teamId: string): Promise<Models.Membership[]> {
  try {
    return (await teams.listMemberships(teamId, [Query.limit(100)])).memberships;
  } catch (error) {
    if ((error as { code?: number }).code === 404) return [];
    throw error;
  }
}

const roleOf = (permission: string) => /^\w+\("([^"]+)"\)$/.exec(permission)?.[1] ?? '';
const userRoleOf = (row: Row) => `user:${row.user_id ?? ''}`;
const report = new Map<string, string[]>();
const flag = (label: string, id: string) => report.set(label, [...(report.get(label) ?? []), id]);

/** Données d'une ligne (inline `gz:`, JSON, ou fichier du bucket). */
async function readDocument(row: Row): Promise<unknown> {
  const data = row.data;
  if (typeof data !== 'string') return data;
  if (data.startsWith('file:')) {
    const bytes = Buffer.from(await storage.getFileDownload('project-payloads', data.slice('file:'.length)));
    return JSON.parse(gunzipSync(bytes, { maxOutputLength: 300 * 1024 * 1024 }).toString('utf8'));
  }
  if (data.startsWith('gz:')) return JSON.parse(gunzipSync(Buffer.from(data.slice(3), 'base64'), { maxOutputLength: 300 * 1024 * 1024 }).toString('utf8'));
  return JSON.parse(data);
}

async function main(): Promise<void> {
  console.log(`Appwrite ${ENDPOINT} · projet ${PROJECT_ID} · base ${DATABASE_ID} · ${APPLY ? 'CORRECTION (--apply)' : 'lecture seule'}`);
  const rows = await listRows('projects', ['$id', '$permissions', 'user_id', 'team_id']);
  const folders = await listRows('project_folders', ['$id', '$permissions', 'user_id']);
  console.log(`${rows.length} projets, ${folders.length} dossiers`);

  const sharedRows: Row[] = [];
  for (const row of rows) {
    const permissions = row.$permissions ?? [];
    const roles = permissions.map(roleOf);
    const expectedTeam = projectTeamId(row.$id);
    if (!roles.includes(userRoleOf(row))) flag('masqué au propriétaire par le filtre du client (aucune permission user:<user_id>)', row.$id);
    if (!corroboratedOwnerId(row)) flag('user_id non corroboré (ni update ni delete pour user:<user_id>)', row.$id);
    if (roles.some((role) => role === 'any' || role === 'users' || role.startsWith('users/'))) flag('lisible par any/users', row.$id);
    if (roles.some((role) => role.startsWith('team:') && role.split('/')[0] !== `team:${expectedTeam}`)) flag('équipe étrangère dans les permissions', row.$id);
    if (roles.some((role) => role.startsWith('user:') && role !== userRoleOf(row))) flag('autre utilisateur dans les permissions', row.$id);
    if (isTeamShared(row)) {
      sharedRows.push(row);
      if (grantsTeamWrite(permissions)) flag('partagé, ancien format (équipe en écriture)', row.$id);
      if (row.team_id !== expectedTeam) flag('partagé, team_id non canonique', row.$id);
    } else if (row.team_id) {
      flag('team_id sans permission d’équipe (partage interrompu ?)', row.$id);
    }
  }
  for (const folder of folders) {
    if (!(folder.$permissions ?? []).map(roleOf).includes(userRoleOf(folder))) flag('dossier masqué à son propriétaire par le filtre du client', folder.$id);
  }

  // Équipes : propriétaires de chaque projet partagé, équipes `p…` sans projet partagé.
  const sharedIds = new Set(sharedRows.map((row) => projectTeamId(row.$id)));
  const owners = new Map<string, string[]>();
  for (const row of sharedRows) {
    const teamId = projectTeamId(row.$id);
    const teamOwners = (await memberships(teamId)).filter((membership) => membership.roles.includes('owner')).map((membership) => membership.userId);
    owners.set(row.$id, teamOwners);
    if (!teamOwners.includes(row.user_id ?? '')) flag('user_id absent des propriétaires de l’équipe (réécrit ?)', row.$id);
    if (teamOwners.some((userId) => userId !== row.user_id)) flag('équipe avec un autre propriétaire que le projet', row.$id);
  }
  const allTeams = await listAll<Models.Team<Models.Preferences>>(async (queries) => (await teams.list(queries)).teams);
  const strayTeams = allTeams.filter((team) => team.$id.startsWith('p') && !sharedIds.has(team.$id));
  for (const team of strayTeams) flag('équipe p… sans projet partagé (squat ou partage interrompu)', team.$id);

  console.log('\n=== Rapport ===');
  if (report.size === 0) console.log('Rien à signaler.');
  for (const [label, ids] of report) console.log(`- ${label} : ${ids.length}${ids.length <= 20 ? ` (${ids.join(', ')})` : ''}`);

  if (CHECK_DOCUMENTS) {
    console.log(`\n=== Documents ${CHECK_ALL ? 'de tous les projets' : 'partagés'} rejoués dans la validation du serveur ===`);
    const reasons = new Map<string, number>();
    for (const row of CHECK_ALL ? rows : sharedRows) {
      const full = await databases.getDocument(DATABASE_ID, 'projects', row.$id) as unknown as Row;
      let raw: unknown;
      try {
        raw = await readDocument(full);
      } catch {
        reasons.set('illisible', (reasons.get('illisible') ?? 0) + 1);
        continue;
      }
      const stored = readStoredProject(raw);
      if (!stored) {
        reasons.set('illisible', (reasons.get('illisible') ?? 0) + 1);
        continue;
      }
      const store = new ObjectStore();
      const { ops, blobs } = documentOps(store, stored.document);
      // Sans auteur : forme, clés, valeurs, segments (un document entier mêle les commentaires de plusieurs éditeurs).
      const check = checkBatch(store, ops, Object.fromEntries(blobs));
      const reason = check.ok ? 'accepté' : check.reason;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (!check.ok) console.log(`  refusé : ${row.$id} (${check.reason})`);
    }
    for (const [reason, count] of reasons) console.log(`- ${reason} : ${count}`);
  }

  if (CHECK_FIT) await auditFitPermissions(sharedRows);

  if (!APPLY) {
    console.log('\nLecture seule : rien n’a été modifié (--apply pour corriger ce qui est sûr).');
    return;
  }

  console.log('\n=== Corrections ===');
  let fixedRows = 0;
  for (const row of sharedRows) {
    const ownerId = corroboratedOwnerId(row);
    const teamOwners = owners.get(row.$id) ?? [];
    // Propriétaire sûr : corroboré ET seul propriétaire de l'équipe. Sinon : à relire à la main.
    if (!ownerId || teamOwners.length !== 1 || teamOwners[0] !== ownerId) {
      console.log(`  laissé (propriétaire ambigu) : ${row.$id}`);
      continue;
    }
    const teamId = projectTeamId(row.$id);
    const permissions = canonicalSharedPermissions(ownerId, teamId);
    if (samePermissions(row.$permissions, permissions) && row.team_id === teamId) continue;
    await databases.updateDocument(DATABASE_ID, 'projects', row.$id, { team_id: teamId }, permissions);
    fixedRows += 1;
  }
  let deletedTeams = 0;
  for (const team of strayTeams) {
    await teams.delete(team.$id);
    deletedTeams += 1;
  }
  console.log(`${fixedRows} ligne(s) mise(s) en conformité, ${deletedTeams} équipe(s) sans projet supprimée(s).`);
}

/** Ids des .fit référencés par un document (`itineraries[].fitUploads[].path`). */
function fitFileIds(document: unknown): string[] {
  const itineraries = (document as { itineraries?: unknown } | null)?.itineraries;
  if (!Array.isArray(itineraries)) return [];
  const ids = new Set<string>();
  for (const itinerary of itineraries) {
    const uploads = (itinerary as { fitUploads?: unknown } | null)?.fitUploads;
    if (!Array.isArray(uploads)) continue;
    for (const upload of uploads) {
      const path = (upload as { path?: unknown } | null)?.path;
      if (typeof path === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(path)) ids.add(path);
    }
  }
  return [...ids];
}

/** Auteur d'un fichier : le compte qui peut le supprimer (seul l'auteur reçoit `delete`). */
const fileAuthor = (permissions: string[]) =>
  permissions.map((permission) => /^delete\("user:([^"]+)"\)$/.exec(permission)?.[1]).find(Boolean) ?? null;

async function auditFitPermissions(sharedRows: Row[]): Promise<void> {
  console.log(`\n=== .fit des projets partagés : lecture de l’équipe${GRANT_FIT ? ' (CORRECTION --grant-fit)' : ''} ===`);
  const counts = new Map<string, number>();
  const count = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  let granted = 0;
  for (const row of sharedRows) {
    const teamId = projectTeamId(row.$id);
    let team: Models.Team<Models.Preferences>;
    try {
      team = await teams.get(teamId);
    } catch {
      count('projet sans équipe (non traité)');
      continue;
    }
    const members = new Set((await memberships(teamId)).filter((membership) => membership.confirm).map((membership) => membership.userId));
    let ids: string[];
    try {
      ids = fitFileIds(await readDocument(await databases.getDocument(DATABASE_ID, 'projects', row.$id) as unknown as Row));
    } catch {
      count('document illisible (non traité)');
      continue;
    }
    const teamRead = `read("team:${teamId}")`;
    for (const fileId of ids) {
      let file: Models.File;
      try {
        file = await storage.getFile(FIT_BUCKET_ID, fileId);
      } catch (error) {
        count((error as { code?: number }).code === 404 ? 'supprimé (référence orpheline, retirée par l’app)' : 'erreur de lecture');
        continue;
      }
      if (file.$permissions.includes(teamRead)) {
        count('déjà lisible par l’équipe');
        continue;
      }
      const author = fileAuthor(file.$permissions);
      if (!author || !members.has(author) || Date.parse(file.$createdAt) < Date.parse(team.$createdAt)) {
        count('à relire (auteur hors de l’équipe, ou fichier antérieur au partage)');
        console.log(`  à relire : projet ${row.$id}, fichier ${fileId}`);
        continue;
      }
      count('à ouvrir à l’équipe (envoyé hors session)');
      if (GRANT_FIT) {
        await storage.updateFile(FIT_BUCKET_ID, fileId, file.name, [...file.$permissions, teamRead]);
        granted += 1;
      }
    }
  }
  if (counts.size === 0) console.log(`Aucun .fit dans les ${sharedRows.length} projet(s) partagé(s).`);
  for (const [label, total] of counts) console.log(`- ${label} : ${total}`);
  if (GRANT_FIT) console.log(`${granted} fichier(s) .fit ouvert(s) à leur équipe.`);
  else if (counts.has('à ouvrir à l’équipe (envoyé hors session)')) console.log('(--grant-fit pour les ouvrir)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
