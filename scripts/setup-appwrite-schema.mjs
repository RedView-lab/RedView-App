const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';
/**
 * `--only=project_views,…` : ne traite que ces collections / buckets
 * (idempotent ; sans option, tout le schéma est vérifié).
 */
const ONLY_ARG = process.argv.find((arg) => arg.startsWith('--only='));
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split(',').filter(Boolean)) : null;

const headers = {
  'Content-Type': 'application/json',
  'X-Appwrite-Project': PROJECT_ID,
  'X-Appwrite-Key': API_KEY,
};

async function api(path, method = 'GET', body = null) {
  const url = `${ENDPOINT}${path}`;
  const init = {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Step 1: Create Database ===');
  const dbCheck = await api(`/databases/${DATABASE_ID}`);
  if (!dbCheck.ok) {
    const dbCreate = await api('/databases', 'POST', {
      databaseId: DATABASE_ID,
      name: 'RedView Production Database',
    });
    console.log('Database create:', dbCreate.status, dbCreate.data?.name || dbCreate.data?.message);
  } else {
    console.log('Database redview-db already exists');
  }

  console.log('\n=== Step 2: Create Collections ===');
  const collections = [
    {
      id: 'projects',
      name: 'Projects',
      documentSecurity: true,
      // Collection/bucket : création seulement. Lecture/écriture accordées
      // par document/fichier à son propriétaire (Role.user) — une permission
      // read("users") ici exposerait les données de TOUS les utilisateurs.
      permissions: ['create("users")'],
      attributes: [
        { type: 'string', key: 'name', size: 255, required: true },
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'folder_id', size: 128, required: false },
        { type: 'integer', key: 'size_bytes', required: false, default: 0, min: 0, max: 2147483647 },
        { type: 'string', key: 'privacy', size: 32, required: false, default: 'private' },
        { type: 'string', key: 'data', size: 16000000, required: false }, // relevé de 1 M à 16 M en prod le 2026-10-01
        // Co-édition : équipe `p<projectId>` d'un projet partagé (api/projects/share.ts).
        { type: 'string', key: 'team_id', size: 128, required: false },
        // Co-édition : `{ v, seq, snapshotFile, dataHash }` écrit avec `data` par le serveur
        // temps réel (server/multiplayer/appwriteStorage.ts).
        { type: 'string', key: 'collab', size: 4096, required: false },
      ],
      indexes: [
        { key: 'idx_projects_user_id', type: 'key', attributes: ['user_id'] },
        { key: 'idx_projects_team_id', type: 'key', attributes: ['team_id'] },
      ],
    },
    {
      // Journal du serveur temps réel (server/multiplayer) : un document par paquet
      // de lots, id `<projet>_<séquence de début>` (deux serveurs ne peuvent pas
      // écrire le même : barrière). Aucun accès client : clé API du serveur seulement.
      id: 'project_journal',
      name: 'Project Journal',
      documentSecurity: true,
      permissions: [],
      attributes: [
        { type: 'string', key: 'project_id', size: 128, required: true },
        { type: 'integer', key: 'start_seq', required: true, min: 0, max: 9007199254740991 },
        { type: 'integer', key: 'end_seq', required: true, min: 0, max: 9007199254740991 },
        // gzip + base64 des lots (MAX_JOURNAL_INLINE_CHARS = 10 M), sinon `file:<id>` du bucket project-payloads.
        { type: 'string', key: 'payload', size: 10500000, required: true },
      ],
      indexes: [
        { key: 'idx_journal_project_end', type: 'key', attributes: ['project_id', 'end_seq'] },
        { key: 'idx_journal_project_start', type: 'key', attributes: ['project_id', 'start_seq'] },
      ],
    },
    {
      // Vue de chaque utilisateur sur chaque projet (itinéraire et mode actifs,
      // panneaux, vue carte, panneau de droite, graphe — src/shared/utils/
      // projects/projectViews.ts), à part du document partagé `projects.data` :
      // la modifier ne crée jamais de version du projet. Id du document =
      // hachage (projet, utilisateur) ; `data` = JSON { updatedAt, view }.
      id: 'project_views',
      name: 'Project Views',
      documentSecurity: true,
      permissions: ['create("users")'],
      attributes: [
        { type: 'string', key: 'project_id', size: 128, required: true },
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'data', size: 1000000, required: true }, // MAX_PROJECT_VIEW_CHARS
      ],
      indexes: [
        // Nettoyage de toutes les vues d'un projet supprimé (côté serveur, à plusieurs éditeurs).
        { key: 'idx_views_project_id', type: 'key', attributes: ['project_id'] },
        { key: 'idx_views_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
    {
      id: 'project_folders',
      name: 'Project Folders',
      documentSecurity: true,
      // Collection/bucket : création seulement. Lecture/écriture accordées
      // par document/fichier à son propriétaire (Role.user) — une permission
      // read("users") ici exposerait les données de TOUS les utilisateurs.
      permissions: ['create("users")'],
      attributes: [
        { type: 'string', key: 'name', size: 255, required: true },
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'parent_folder_id', size: 128, required: false },
        { type: 'string', key: 'privacy', size: 32, required: false, default: 'private' },
      ],
      indexes: [
        { key: 'idx_folders_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
    {
      id: 'customers',
      name: 'Stripe Customers',
      documentSecurity: true,
      permissions: [],
      attributes: [
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'stripe_customer_id', size: 128, required: true },
        { type: 'string', key: 'billing_email_mode', size: 32, required: false },
        { type: 'string', key: 'billing_email', size: 255, required: false },
      ],
      indexes: [
        { key: 'idx_customers_user_id', type: 'key', attributes: ['user_id'] },
        { key: 'idx_customers_stripe_id', type: 'key', attributes: ['stripe_customer_id'] },
      ],
    },
    {
      id: 'subscriptions',
      name: 'User Subscriptions',
      documentSecurity: true,
      permissions: [],
      attributes: [
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'status', size: 64, required: true },
        { type: 'string', key: 'price_id', size: 128, required: false },
        { type: 'string', key: 'current_period_start', size: 64, required: false },
        { type: 'string', key: 'current_period_end', size: 64, required: false },
        { type: 'boolean', key: 'cancel_at_period_end', required: false, default: false },
      ],
      indexes: [
        { key: 'idx_subs_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
  ];

  for (const col of collections) {
    if (ONLY && !ONLY.has(col.id)) continue;
    console.log(`Checking collection ${col.id}...`);
    const check = await api(`/databases/${DATABASE_ID}/collections/${col.id}`);
    if (!check.ok) {
      const res = await api(`/databases/${DATABASE_ID}/collections`, 'POST', {
        collectionId: col.id,
        name: col.name,
        permissions: col.permissions,
        documentSecurity: col.documentSecurity,
      });
      console.log(`Created collection ${col.id}:`, res.status);
    } else {
      console.log(`Collection ${col.id} exists`);
    }

    // Add attributes
    for (const attr of col.attributes) {
      let attrPath = `/databases/${DATABASE_ID}/collections/${col.id}/attributes/${attr.type}`;
      const payload = {
        key: attr.key,
        required: attr.required,
      };
      if (attr.type === 'string') {
        payload.size = attr.size;
        if (attr.default !== undefined) payload.default = attr.default;
      } else if (attr.type === 'integer') {
        if (attr.min !== undefined) payload.min = attr.min;
        if (attr.max !== undefined) payload.max = attr.max;
        if (attr.default !== undefined) payload.default = attr.default;
      } else if (attr.type === 'boolean') {
        if (attr.default !== undefined) payload.default = attr.default;
      }

      const attrRes = await api(attrPath, 'POST', payload);
      if (attrRes.ok || attrRes.status === 409) {
        console.log(`  Attribute ${col.id}.${attr.key}: OK (${attrRes.status})`);
      } else {
        console.log(`  Attribute ${col.id}.${attr.key} error:`, attrRes.status, attrRes.data?.message);
      }
      await sleep(100);
    }

    // Wait for attributes to be in 'available' status before adding indexes
    console.log(`Waiting for attributes in ${col.id} to be processed...`);
    await sleep(1500);

    // Add indexes
    for (const idx of col.indexes) {
      const idxRes = await api(`/databases/${DATABASE_ID}/collections/${col.id}/indexes`, 'POST', {
        key: idx.key,
        type: idx.type,
        attributes: idx.attributes,
      });
      if (idxRes.ok || idxRes.status === 409) {
        console.log(`  Index ${col.id}.${idx.key}: OK (${idxRes.status})`);
      } else {
        console.log(`  Index ${col.id}.${idx.key} error:`, idxRes.status, idxRes.data?.message);
      }
      await sleep(100);
    }
  }

  console.log('\n=== Step 3: Create Storage Buckets ===');
  const buckets = [
    {
      id: 'project-thumbnails',
      name: 'Project Thumbnails',
      // Collection/bucket : création seulement. Lecture/écriture accordées
      // par document/fichier à son propriétaire (Role.user) — une permission
      // read("users") ici exposerait les données de TOUS les utilisateurs.
      permissions: ['create("users")'],
      fileSecurity: true,
      maxFileSize: 10485760, // 10MB
      allowedFileExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    },
    {
      id: 'itinerary-fit-files',
      name: 'Itinerary FIT Files',
      // Collection/bucket : création seulement. Lecture/écriture accordées
      // par document/fichier à son propriétaire (Role.user) — une permission
      // read("users") ici exposerait les données de TOUS les utilisateurs.
      permissions: ['create("users")'],
      fileSecurity: true,
      maxFileSize: 30000000, // 30MB
      allowedFileExtensions: ['fit'],
    },
    {
      // Gros projets dont le JSON gzip dépasse ce que le document `projects.data`
      // accepte (≈12 M car. derrière nginx) : `<projectId>.json.gz`, pointé par
      // `data = "file:<fileId>"` (src/shared/utils/projects/payloadFiles.ts).
      id: 'project-payloads',
      name: 'Project Payloads',
      // Collection/bucket : création seulement. Lecture/écriture accordées
      // par document/fichier à son propriétaire (Role.user) — une permission
      // read("users") ici exposerait les données de TOUS les utilisateurs.
      permissions: ['create("users")'],
      fileSecurity: true,
      maxFileSize: 30000000, // 30MB = MAX_CLOUD_PROJECT_FILE_BYTES (≤ _APP_STORAGE_LIMIT)
      allowedFileExtensions: ['gz'],
      compression: 'none', // déjà gzip côté client
    },
  ];

  for (const b of buckets) {
    if (ONLY && !ONLY.has(b.id)) continue;
    console.log(`Checking bucket ${b.id}...`);
    const check = await api(`/storage/buckets/${b.id}`);
    if (!check.ok) {
      const bRes = await api('/storage/buckets', 'POST', {
        bucketId: b.id,
        name: b.name,
        permissions: b.permissions,
        fileSecurity: b.fileSecurity,
        maximumFileSize: b.maxFileSize,
        allowedFileExtensions: b.allowedFileExtensions,
        ...(b.compression ? { compression: b.compression } : {}),
      });
      console.log(`Created bucket ${b.id}:`, bRes.status, bRes.data?.name || bRes.data?.message);
    } else {
      console.log(`Bucket ${b.id} exists`);
    }
  }

  console.log('\n=== Setup Complete! ===');
}

main().catch(console.error);
