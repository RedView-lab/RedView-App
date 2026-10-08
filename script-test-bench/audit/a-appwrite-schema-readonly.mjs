/**
 * Audit A — LECTURE SEULE (GET uniquement) du schéma Appwrite + stats de taille.
 * - taille réelle de l'attribut `projects.data` (vs scripts/appwrite/setup-appwrite-schema.mjs)
 * - index présents (user_id, folder_id, parent_folder_id)
 * - distribution de `size_bytes` des projets existants (aucun contenu lu : Query.select)
 * - motifs de permissions des documents subscriptions / customers (un user peut-il modifier son abonnement ?)
 * Usage : node script-test-bench/audit/a-appwrite-schema-readonly.mjs   (charge ../../.env)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envPath); } catch { /* */ }
}
const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DB = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const KEY = process.env.APPWRITE_API_KEY || '';
if (!KEY) { console.error('APPWRITE_API_KEY manquant'); process.exit(2); }
const headers = { 'X-Appwrite-Project': PROJECT_ID, 'X-Appwrite-Key': KEY };

async function get(p, queries = []) {
  const qs = queries.map((q) => `queries[]=${encodeURIComponent(JSON.stringify(q))}`).join('&');
  const res = await fetch(`${ENDPOINT}${p}${qs ? `?${qs}` : ''}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status} ${data?.message ?? ''}`);
  return data;
}
async function all(p, key, extra = []) {
  const out = []; let cursor = null;
  for (;;) {
    const q = [{ method: 'limit', values: [100] }, ...extra];
    if (cursor) q.push({ method: 'cursorAfter', values: [cursor] });
    const d = await get(p, q); const items = d[key] ?? [];
    out.push(...items);
    if (items.length < 100) return out;
    cursor = items[items.length - 1].$id;
  }
}
const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0;

for (const col of ['projects', 'project_folders', 'subscriptions', 'customers']) {
  const c = await get(`/databases/${DB}/collections/${col}`);
  console.log(`\n== ${col} (documentSecurity=${c.documentSecurity}, enabled=${c.enabled})`);
  for (const a of c.attributes ?? []) {
    console.log(`  attr ${a.key}: ${a.type}${a.size ? ` size=${a.size}` : ''} required=${a.required} status=${a.status}`);
  }
  for (const i of c.indexes ?? []) console.log(`  index ${i.key}: ${i.type} [${i.attributes.join(',')}] status=${i.status}`);
}

// distribution de size_bytes (aucun contenu de données récupéré)
const projects = await all(`/databases/${DB}/collections/projects/documents`, 'documents', [
  { method: 'select', values: ['$id', 'user_id', 'size_bytes', '$updatedAt'] },
]);
const sizes = projects.map((d) => d.size_bytes ?? 0).sort((a, b) => a - b);
const perUser = new Map();
for (const d of projects) perUser.set(d.user_id, (perUser.get(d.user_id) ?? 0) + 1);
console.log(`\n== projects size_bytes (uncompressed JSON) n=${sizes.length}`);
console.log(`  p50=${pct(sizes, 0.5)} p90=${pct(sizes, 0.9)} max=${sizes.at(-1)} (bytes)`);
console.log(`  > 1 MB: ${sizes.filter((s) => s > 1e6).length}, > 3 MB: ${sizes.filter((s) => s > 3e6).length}`);
console.log(`  users=${perUser.size}, max projects per user=${Math.max(0, ...perUser.values())}`);
console.log(`  user_id='dev-user-001' docs: ${projects.filter((d) => d.user_id === 'dev-user-001').length}`);

for (const col of ['subscriptions', 'customers', 'project_folders']) {
  const docs = await all(`/databases/${DB}/collections/${col}/documents`, 'documents', [
    { method: 'select', values: ['$id', '$permissions'] },
  ]).catch(async () => all(`/databases/${DB}/collections/${col}/documents`, 'documents'));
  const patterns = new Map();
  for (const d of docs) {
    const pat = (d.$permissions ?? []).map((p) => p.replace(/user:[^"]+/, 'user:<id>')).sort().join(' ');
    patterns.set(pat, (patterns.get(pat) ?? 0) + 1);
  }
  console.log(`\n== ${col} document permission patterns`);
  for (const [p, n] of patterns) console.log(`  ${n} x ${p || '(none)'}`);
}
const projPatterns = new Map();
const projDocs = await all(`/databases/${DB}/collections/projects/documents`, 'documents', [
  { method: 'select', values: ['$id', '$permissions'] },
]);
for (const d of projDocs) {
  const pat = (d.$permissions ?? []).map((p) => p.replace(/user:[^"]+/, 'user:<id>')).sort().join(' ');
  projPatterns.set(pat, (projPatterns.get(pat) ?? 0) + 1);
}
console.log('\n== projects document permission patterns');
for (const [p, n] of projPatterns) console.log(`  ${n} x ${p || '(none)'}`);

// Longueur réelle du champ `data` (compressé) — seules les longueurs sont calculées, aucun contenu affiché.
if (process.argv.includes('--data-lengths')) {
  const ids = projects.map((d) => d.$id);
  const rows = [];
  for (const id of ids) {
    const d = await get(`/databases/${DB}/collections/projects/documents/${id}`, [
      { method: 'select', values: ['$id', 'data', 'size_bytes', '$updatedAt'] },
    ]);
    const len = typeof d.data === 'string' ? d.data.length : 0;
    rows.push({ len, size: d.size_bytes ?? 0, gz: typeof d.data === 'string' && d.data.startsWith('gz:'), updated: d.$updatedAt });
  }
  rows.sort((a, b) => b.len - a.len);
  console.log(`\n== projects.data longueur (car.) n=${rows.length} ; limite 1 000 000`);
  console.log(`  > 900 000 : ${rows.filter((r) => r.len > 900_000).length} ; > 750 000 : ${rows.filter((r) => r.len > 750_000).length} ; > 500 000 : ${rows.filter((r) => r.len > 500_000).length} ; non compressés : ${rows.filter((r) => !r.gz && r.len > 0).length}`);
  console.log('  top 8 (longueur / size_bytes JSON / ratio / dernière maj) :');
  for (const r of rows.slice(0, 8)) console.log(`   ${r.len} / ${r.size} / ${(r.size / Math.max(1, r.len)).toFixed(2)} / ${r.updated}`);
}
