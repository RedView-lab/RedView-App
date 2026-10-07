/**
 * Migration des permissions des miniatures existantes (bucket `project-thumbnails`).
 *
 * Les miniatures étaient créées avec `read("any")` : lisibles par n'importe
 * qui, sans authentification. On remplace `read("any")` par
 * `read("user:<owner>")`, le propriétaire étant celui qui porte déjà
 * `update("user:…")` / `delete("user:…")` sur le fichier.
 *
 * Usage:
 *   node scripts/appwrite/migrate-thumbnail-permissions.mjs           # dry-run (aucune écriture)
 *   node scripts/appwrite/migrate-thumbnail-permissions.mjs --apply   # applique
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
const API_KEY = process.env.APPWRITE_API_KEY || '';
const BUCKET_ID = 'project-thumbnails';
const APPLY = process.argv.includes('--apply');

if (!API_KEY) {
  console.error('[migrate-thumbnails] APPWRITE_API_KEY manquant (.env).');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'X-Appwrite-Project': PROJECT_ID,
  'X-Appwrite-Key': API_KEY,
};

async function api(urlPath, method = 'GET', body = null) {
  const res = await fetch(`${ENDPOINT}${urlPath}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function* listFiles() {
  let cursor = null;
  for (;;) {
    const queries = [{ method: 'limit', values: [100] }];
    if (cursor) queries.push({ method: 'cursorAfter', values: [cursor] });
    const qs = queries.map((q) => `queries[]=${encodeURIComponent(JSON.stringify(q))}`).join('&');
    const res = await api(`/storage/buckets/${BUCKET_ID}/files?${qs}`);
    if (!res.ok) throw new Error(`listFiles → ${res.status} ${res.data?.message ?? ''}`);
    const files = res.data.files ?? [];
    for (const file of files) yield file;
    if (files.length < 100) return;
    cursor = files[files.length - 1].$id;
  }
}

function ownerOf(permissions) {
  for (const perm of permissions) {
    const match = perm.match(/^(?:update|delete|write)\("user:([^"/]+)"\)$/);
    if (match) return match[1];
  }
  return null;
}

async function main() {
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — bucket ${BUCKET_ID}\n`);
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for await (const file of listFiles()) {
    const perms = file.$permissions ?? [];
    if (!perms.some((p) => /\("(any|users|guests)"\)/.test(p) && p.startsWith('read('))) continue;

    const owner = ownerOf(perms);
    if (!owner) {
      skipped += 1;
      console.warn(`  ? ${file.$id} : propriétaire introuvable (${perms.join(', ')}) — ignoré`);
      continue;
    }

    const next = [
      ...new Set([
        ...perms.filter((p) => !/\("(any|users|guests)"\)/.test(p)),
        `read("user:${owner}")`,
      ]),
    ];
    changed += 1;
    console.log(`  ${file.$id} : ${JSON.stringify(perms)} → ${JSON.stringify(next)}`);
    if (!APPLY) continue;

    const res = await api(`/storage/buckets/${BUCKET_ID}/files/${file.$id}`, 'PUT', { permissions: next });
    if (!res.ok) {
      failed += 1;
      console.warn(`    ✖ échec (${res.status}) : ${res.data?.message ?? ''}`);
    }
  }

  console.log(`\n${changed} fichier(s) ${APPLY ? 'migré(s)' : 'à migrer'}, ${skipped} ignoré(s), ${failed} échec(s).`);
  if (!APPLY && changed > 0) console.log('Relancer avec --apply pour appliquer.');
}

main().catch((err) => {
  console.error('[migrate-thumbnails] Échec :', err.message);
  process.exit(1);
});
