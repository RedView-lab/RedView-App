/**
 * Comptes de test du banc de charge du VPS (production) : `loadtest-NNN@redview.tech`,
 * e-mail vérifié, étiquetés `internal` (exclus des statistiques et du rapport
 * d'activation) et `loadtest`. Mots de passe aléatoires rangés HORS du dépôt
 * (~/.redview/load-test-accounts.json, jamais affichés) : seul le compte 000
 * (sonde navigateur) s'en sert ; les utilisateurs virtuels reçoivent une session
 * créée par la clé d'administration (`users.createSession`), supprimée à la fin.
 *
 *   npx tsx --env-file=.env script-test-bench/vps-load/accounts.ts ensure --count 101
 *   npx tsx --env-file=.env script-test-bench/vps-load/accounts.ts teardown
 *
 * `teardown` passe chaque compte par la vraie purge RGPD (api/_lib/accountDeletion.ts :
 * projets, équipes, journal et instantanés de la co-édition, fichiers des trois
 * buckets, vues, dossiers, puis le compte) : rien ne reste en production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ID, Query } from 'node-appwrite';

import { getAppwriteUsers } from '../../api/_lib/appwrite.ts';

export const LOAD_TEST_LABEL = 'loadtest';
const INTERNAL_LABEL = 'internal';
const STORE = path.join(os.homedir(), '.redview', 'load-test-accounts.json');
const EMAIL_RE = /^loadtest-(\d{3})@redview\.tech$/;

export interface LoadTestAccount {
  index: number;
  userId: string;
  email: string;
  name: string;
  password: string;
}

export interface LoadTestSession extends LoadTestAccount {
  /** Secret de session Appwrite (en-tête `X-Appwrite-Session`), jamais écrit sur disque. */
  secret: string;
  sessionId: string;
}

function accountEmail(index: number): string {
  return `loadtest-${String(index).padStart(3, '0')}@redview.tech`;
}

function readStore(): Record<string, LoadTestAccount> {
  return existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, LoadTestAccount> : {};
}

function writeStore(store: Record<string, LoadTestAccount>): void {
  mkdirSync(path.dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Comptes `loadtest-*` existants en production (tous, pas seulement ceux du fichier local). */
async function listLoadTestUsers() {
  const users = getAppwriteUsers();
  const found = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const queries = [Query.startsWith('email', 'loadtest-'), Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const list = await users.list(queries);
    found.push(...list.users.filter((user) => EMAIL_RE.test(user.email) && (user.labels ?? []).includes(LOAD_TEST_LABEL)));
    if (list.users.length < 100) break;
    cursor = list.users[list.users.length - 1].$id;
  }
  return found;
}

/** Crée ou retrouve les comptes 000 … count-1 (petits lots parallèles : la clé d'administration n'a pas de limite d'abus). */
export async function ensureAccounts(count: number): Promise<LoadTestAccount[]> {
  const users = getAppwriteUsers();
  const store = readStore();
  const existing = new Map((await listLoadTestUsers()).map((user) => [user.email, user]));
  const result: LoadTestAccount[] = [];
  const indexes = Array.from({ length: count }, (_, index) => index);
  for (let start = 0; start < indexes.length; start += 8) {
    const batch = await Promise.all(indexes.slice(start, start + 8).map(async (index) => {
      const email = accountEmail(index);
      const name = `Charge ${String(index).padStart(3, '0')}`;
      let user = existing.get(email);
      let password = store[email]?.password;
      if (!user) {
        password = randomBytes(18).toString('base64url');
        user = await users.create(ID.unique(), email, undefined, password, name);
      } else if (!password) {
        password = randomBytes(18).toString('base64url');
        await users.updatePassword(user.$id, password);
      }
      if (!user.emailVerification) await users.updateEmailVerification(user.$id, true);
      const labels = new Set(user.labels ?? []);
      if (!labels.has(INTERNAL_LABEL) || !labels.has(LOAD_TEST_LABEL)) {
        await users.updateLabels(user.$id, [...new Set([...labels, INTERNAL_LABEL, LOAD_TEST_LABEL])]);
      }
      return { index, userId: user.$id, email, name, password: password! };
    }));
    result.push(...batch);
  }
  for (const account of result) store[account.email] = account;
  writeStore(store);
  return result;
}

/** Une session par compte, créée par la clé d'administration (aucune limite d'abus par e-mail). */
export async function createSessions(accounts: LoadTestAccount[]): Promise<LoadTestSession[]> {
  const users = getAppwriteUsers();
  const sessions: LoadTestSession[] = [];
  for (let start = 0; start < accounts.length; start += 8) {
    sessions.push(...await Promise.all(accounts.slice(start, start + 8).map(async (account) => {
      const session = await users.createSession(account.userId);
      if (!session.secret) throw new Error(`session sans secret pour ${account.email}`);
      return { ...account, secret: session.secret, sessionId: session.$id };
    })));
  }
  return sessions;
}

/** Supprime toutes les sessions des comptes de test (fin de passe, y compris après une erreur). */
export async function deleteSessions(accounts: Array<Pick<LoadTestAccount, 'userId'>>): Promise<void> {
  const users = getAppwriteUsers();
  for (let start = 0; start < accounts.length; start += 8) {
    await Promise.all(accounts.slice(start, start + 8).map((account) => users.deleteSessions(account.userId).catch(() => undefined)));
  }
}

/** Purge complète de chaque compte `loadtest-*` de production par le vrai chemin de suppression de compte. */
export async function teardownAccounts(log: (line: string) => void = console.log): Promise<number> {
  const { deleteAccount } = await import('../../api/_lib/accountDeletion.ts');
  const found = await listLoadTestUsers();
  let done = 0;
  for (const user of found) {
    await deleteAccount(user.$id);
    done += 1;
    if (done % 10 === 0 || done === found.length) log(`comptes de test supprimés : ${done}/${found.length}`);
  }
  if (existsSync(STORE)) writeStore({});
  return done;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const command = process.argv[2];
  const countArg = process.argv.indexOf('--count');
  if (!process.env.APPWRITE_API_KEY) {
    console.error('APPWRITE_API_KEY manquant (lancer avec --env-file=.env)');
    process.exit(1);
  }
  if (command === 'ensure') {
    const count = countArg >= 0 ? Number(process.argv[countArg + 1]) : 101;
    const accounts = await ensureAccounts(count);
    console.log(`${accounts.length} comptes de test prêts (identifiants : ${STORE}, hors dépôt)`);
  } else if (command === 'teardown') {
    const done = await teardownAccounts();
    console.log(`${done} comptes de test purgés`);
  } else {
    console.error('usage : accounts.ts ensure [--count N] | teardown');
    process.exit(1);
  }
}
