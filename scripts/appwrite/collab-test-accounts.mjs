/**
 * Comptes de test de la co-édition (E2E en production) : crée ou retrouve deux
 * comptes Appwrite (e-mail vérifié), mots de passe aléatoires rangés HORS du
 * dépôt (~/.redview/collab-test-accounts.json, jamais affichés).
 *
 *   node --env-file=.env scripts/appwrite/collab-test-accounts.mjs          crée / vérifie
 *   node --env-file=.env scripts/appwrite/collab-test-accounts.mjs --reset  nouveaux mots de passe
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client, ID, Query, Users } from 'node-appwrite';

const ACCOUNTS = [
  { key: 'A', email: 'collab-test-a@redview.tech', name: 'Test co-édition A' },
  { key: 'B', email: 'collab-test-b@redview.tech', name: 'Test co-édition B' },
];
const STORE = path.join(os.homedir(), '.redview', 'collab-test-accounts.json');
const INTERNAL_LABEL = 'internal';

const apiKey = process.env.APPWRITE_API_KEY;
if (!apiKey) {
  console.error('APPWRITE_API_KEY manquant (lancer avec --env-file=.env)');
  process.exit(1);
}
const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(apiKey);
const users = new Users(client);

const reset = process.argv.includes('--reset');
const stored = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {};
const result = {};

for (const account of ACCOUNTS) {
  const found = (await users.list([Query.equal('email', account.email), Query.limit(1)])).users[0];
  let password = stored[account.key]?.password;
  let user = found;
  if (!user) {
    password = randomBytes(18).toString('base64url');
    user = await users.create(ID.unique(), account.email, undefined, password, account.name);
    console.log(`${account.key} : compte créé (${account.email}, ${user.$id})`);
  } else if (reset || !password) {
    password = randomBytes(18).toString('base64url');
    await users.updatePassword(user.$id, password);
    console.log(`${account.key} : mot de passe renouvelé (${account.email}, ${user.$id})`);
  } else {
    console.log(`${account.key} : compte existant (${account.email}, ${user.$id})`);
  }
  if (!user.emailVerification) await users.updateEmailVerification(user.$id, true);
  if (user.name !== account.name) await users.updateName(user.$id, account.name);
  // Compte interne : exclu de la mesure d'audience et du rapport d'activation (docs/ANALYTICS.md).
  if (!(user.labels ?? []).includes(INTERNAL_LABEL)) await users.updateLabels(user.$id, [...(user.labels ?? []), INTERNAL_LABEL]);
  result[account.key] = { userId: user.$id, email: account.email, name: account.name, password };
}

mkdirSync(path.dirname(STORE), { recursive: true });
writeFileSync(STORE, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(`Identifiants : ${STORE} (hors dépôt)`);
