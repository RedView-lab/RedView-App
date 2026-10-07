/**
 * Audit LECTURE SEULE des permissions Appwrite (aucune écriture).
 *
 * Liste, pour chaque collection de la base et chaque bucket de stockage :
 *   - les permissions au niveau collection / bucket ;
 *   - documentSecurity / fileSecurity ;
 *   - le nombre de documents / fichiers portant une permission trop large
 *     (`any`, `users`, `guests`) au niveau document / fichier.
 *
 * Une permission `read("users")` au niveau collection/bucket donne à TOUT
 * utilisateur connecté l'accès à TOUS les documents/fichiers, quelles que
 * soient les permissions par document — c'est ce que l'audit signale.
 *
 * Usage:
 *   node scripts/appwrite/audit-appwrite-permissions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // déjà chargé
  }
}

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';

if (!API_KEY) {
  console.error('[audit-appwrite] APPWRITE_API_KEY manquant (.env).');
  process.exit(1);
}

const headers = { 'X-Appwrite-Project': PROJECT_ID, 'X-Appwrite-Key': API_KEY };
const BROAD_ROLE_RE = /\("(any|users|guests)"\)/;
const PAGE = 100;

async function get(urlPath, queries = []) {
  const qs = queries.map((q) => `queries[]=${encodeURIComponent(JSON.stringify(q))}`).join('&');
  const res = await fetch(`${ENDPOINT}${urlPath}${qs ? `?${qs}` : ''}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${urlPath} → ${res.status} ${data?.message ?? ''}`);
  return data;
}

async function* paginate(urlPath, key) {
  let cursor = null;
  for (;;) {
    const queries = [{ method: 'limit', values: [PAGE] }];
    if (cursor) queries.push({ method: 'cursorAfter', values: [cursor] });
    const data = await get(urlPath, queries);
    const items = data[key] ?? [];
    for (const item of items) yield item;
    if (items.length < PAGE) return;
    cursor = items[items.length - 1].$id;
  }
}

function broadPermissions(perms) {
  return (perms ?? []).filter((p) => BROAD_ROLE_RE.test(p));
}

function flag(perms) {
  // `create("users")` au niveau collection/bucket est voulu (chacun crée ses
  // propres documents) ; tout read/update/delete large est une fuite.
  return broadPermissions(perms).filter((p) => !p.startsWith('create('));
}

async function auditItems(urlPath, key) {
  let total = 0;
  let broad = 0;
  const samples = [];
  for await (const item of paginate(urlPath, key)) {
    total += 1;
    const wide = broadPermissions(item.$permissions);
    if (wide.length > 0) {
      broad += 1;
      if (samples.length < 3) samples.push(`${item.$id}: ${wide.join(', ')}`);
    }
  }
  return { total, broad, samples };
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT} | Project: ${PROJECT_ID} | Database: ${DATABASE_ID}\n`);
  const problems = [];

  console.log('── Collections ──');
  for await (const col of paginate(`/databases/${DATABASE_ID}/collections`, 'collections')) {
    const wide = flag(col.$permissions);
    const items = await auditItems(`/databases/${DATABASE_ID}/collections/${col.$id}/documents`, 'documents');
    console.log(`• ${col.$id}  documentSecurity=${col.documentSecurity}`);
    console.log(`    permissions collection : ${JSON.stringify(col.$permissions)}`);
    console.log(`    documents : ${items.total} (dont ${items.broad} avec any/users/guests)`);
    for (const s of items.samples) console.log(`      ex. ${s}`);
    if (wide.length > 0) problems.push(`collection ${col.$id} : ${wide.join(', ')} au niveau collection`);
    if (items.broad > 0) problems.push(`collection ${col.$id} : ${items.broad} document(s) avec permission large`);
  }

  console.log('\n── Buckets ──');
  for await (const bucket of paginate('/storage/buckets', 'buckets')) {
    const wide = flag(bucket.$permissions);
    const items = await auditItems(`/storage/buckets/${bucket.$id}/files`, 'files');
    console.log(`• ${bucket.$id}  fileSecurity=${bucket.fileSecurity}  maxSize=${bucket.maximumFileSize}`);
    console.log(`    permissions bucket : ${JSON.stringify(bucket.$permissions)}`);
    console.log(`    fichiers : ${items.total} (dont ${items.broad} avec any/users/guests)`);
    for (const s of items.samples) console.log(`      ex. ${s}`);
    if (wide.length > 0) problems.push(`bucket ${bucket.$id} : ${wide.join(', ')} au niveau bucket`);
    if (items.broad > 0) problems.push(`bucket ${bucket.$id} : ${items.broad} fichier(s) avec permission large`);
  }

  console.log('\n── Résultat ──');
  if (problems.length === 0) {
    console.log('Aucune permission trop large détectée.');
  } else {
    for (const p of problems) console.log(`⚠ ${p}`);
  }
}

main().catch((err) => {
  console.error('[audit-appwrite] Échec :', err.message);
  process.exit(1);
});
