/**
 * Fichiers FIT orphelins du bucket `itinerary-fit-files` : présents dans le
 * bucket mais référencés par aucun projet (traces GPS et fréquence cardiaque
 * de projets ou d'itinéraires supprimés avant 241f507, qui ne les effaçait pas).
 *
 *   npx tsx --env-file=.env scripts/appwrite/fit-orphans.ts                  # lecture seule : rapport
 *   npx tsx --env-file=.env scripts/appwrite/fit-orphans.ts --apply          # efface les orphelins
 *   npx tsx --env-file=.env scripts/appwrite/fit-orphans.ts --min-age-days=14
 *
 * Un fichier n'est orphelin que s'il a plus de `--min-age-days` jours (7 par
 * défaut) : un fichier tout juste envoyé peut n'être référencé que par la
 * copie locale d'un appareil qui n'a pas encore synchronisé le projet.
 * Les références sont lues dans le document de chaque projet (en ligne `gz:`,
 * JSON, ou fichier `file:` du bucket `project-payloads`) ; un projet illisible
 * arrête tout, sans rien effacer (ses fichiers passeraient pour orphelins).
 *
 * Rapport : nombres, tailles et identifiants seulement — jamais le nom d'un
 * fichier ni son contenu (données personnelles).
 */
import { gunzipSync } from 'node:zlib';

import { Client, Databases, Query, Storage, type Models } from 'node-appwrite';

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';
const FIT_BUCKET = 'itinerary-fit-files';
const PAYLOAD_BUCKET = 'project-payloads';
const APPLY = process.argv.includes('--apply');
const MIN_AGE_DAYS = Number(/^--min-age-days=(\d+)$/.exec(process.argv.find((arg) => arg.startsWith('--min-age-days=')) ?? '')?.[1] ?? 7);

if (!API_KEY) {
  console.error('APPWRITE_API_KEY manquant (lancer avec --env-file=.env).');
  process.exit(1);
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(API_KEY);
const databases = new Databases(client);
const storage = new Storage(client);

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

interface Row {
  $id: string;
  data?: unknown;
}

/** Document d'un projet (inline `gz:`, JSON, ou fichier du bucket des charges utiles). */
async function readDocument(row: Row): Promise<unknown> {
  const data = row.data;
  if (typeof data !== 'string') return data;
  const gunzip = (bytes: Buffer) => JSON.parse(gunzipSync(bytes, { maxOutputLength: 300 * 1024 * 1024 }).toString('utf8'));
  if (data.startsWith('file:')) return gunzip(Buffer.from(await storage.getFileDownload(PAYLOAD_BUCKET, data.slice('file:'.length))));
  if (data.startsWith('gz:')) return gunzip(Buffer.from(data.slice(3), 'base64'));
  return data ? JSON.parse(data) : null;
}

/** Chemins de tous les `fitUploads[].path` d'une valeur, où qu'ils soient dans le document. */
function collectFitPaths(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFitPaths(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'fitUploads' && Array.isArray(child)) {
      for (const upload of child) {
        const path = (upload as { path?: unknown } | null)?.path;
        if (typeof path === 'string' && path) into.add(path);
      }
    } else {
      collectFitPaths(child, into);
    }
  }
}

async function main(): Promise<void> {
  const rows = await listAll<Row>(async (queries) =>
    (await databases.listDocuments(DATABASE_ID, 'projects', [...queries, Query.select(['$id', 'data'])])).documents as unknown as Row[]);
  const referenced = new Set<string>();
  for (const row of rows) collectFitPaths(await readDocument(row), referenced);

  const files = await listAll<Models.File>(async (queries) => (await storage.listFiles(FIT_BUCKET, queries)).files);
  const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 3600 * 1000;
  const unreferenced = files.filter((file) => !referenced.has(file.$id));
  const orphans = unreferenced.filter((file) => Date.parse(file.$createdAt) < cutoff);
  const bytes = orphans.reduce((sum, file) => sum + file.sizeOriginal, 0);

  console.log(`${rows.length} projets, ${referenced.size} fichiers FIT référencés`);
  console.log(`${files.length} fichiers dans le bucket, ${unreferenced.length} non référencés, dont ${orphans.length} de plus de ${MIN_AGE_DAYS} jours (${(bytes / 1048576).toFixed(1)} Mio)`);
  const missing = [...referenced].filter((id) => !files.some((file) => file.$id === id));
  if (missing.length) console.log(`${missing.length} référence(s) vers un fichier absent du bucket (déjà effacé)`);

  if (!APPLY) {
    if (orphans.length) console.log('Lecture seule : relancer avec --apply pour les effacer.');
    return;
  }
  let deleted = 0;
  for (const file of orphans) {
    try {
      await storage.deleteFile(FIT_BUCKET, file.$id);
      deleted += 1;
    } catch (error) {
      console.warn(`échec de l'effacement de ${file.$id} :`, (error as Error).message);
    }
  }
  console.log(`${deleted}/${orphans.length} fichiers orphelins effacés`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
