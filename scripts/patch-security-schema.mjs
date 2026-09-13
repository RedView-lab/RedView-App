/**
 * Script de durcissement et mise à jour des permissions Appwrite existantes.
 * Met à jour les collections `customers` et `subscriptions` ainsi que le bucket `project-thumbnails`.
 *
 * Usage:
 *   node scripts/patch-security-schema.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

// Chargement natif du fichier .env sans dépendance externe
if (fs.existsSync(envPath)) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
    }
  } catch {
    // Ignorer si déjà chargé
  }
  try {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.warn('[patch-security-schema] Note: Erreur lecture .env manuel:', err.message);
  }
}

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';

if (!API_KEY) {
  console.error('[patch-security-schema] ❌ Erreur: APPWRITE_API_KEY manquant dans l’environnement ou dans redview-app/.env.');
  console.error('Assurez-vous que votre clé d’API Appwrite serveur est renseignée dans .env (APPWRITE_API_KEY=...).');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'X-Appwrite-Project': PROJECT_ID,
  'X-Appwrite-Key': API_KEY,
};

async function api(urlPath, method = 'GET', body = null) {
  const url = `${ENDPOINT}${urlPath}`;
  const init = {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log('=== Mise à jour de la sécurité du Schéma Appwrite ===');
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Project:  ${PROJECT_ID}`);
  console.log(`Database: ${DATABASE_ID}\n`);

  // 1. Durcir la collection 'customers'
  console.log("1. Sécurisation de la collection 'customers' (documentSecurity: true, permissions: [])...");
  const customersRes = await api(`/databases/${DATABASE_ID}/collections/customers`, 'PUT', {
    name: 'Stripe Customers',
    permissions: [],
    documentSecurity: true,
  });
  if (customersRes.ok) {
    console.log("   ✅ Collection 'customers' sécurisée avec succès.");
  } else {
    console.warn(`   ⚠️ Erreur mise à jour 'customers' (${customersRes.status}):`, customersRes.data?.message);
  }

  // 2. Durcir la collection 'subscriptions'
  console.log("\n2. Sécurisation de la collection 'subscriptions' (documentSecurity: true, permissions: [])...");
  const subsRes = await api(`/databases/${DATABASE_ID}/collections/subscriptions`, 'PUT', {
    name: 'User Subscriptions',
    permissions: [],
    documentSecurity: true,
  });
  if (subsRes.ok) {
    console.log("   ✅ Collection 'subscriptions' sécurisée avec succès.");
  } else {
    console.warn(`   ⚠️ Erreur mise à jour 'subscriptions' (${subsRes.status}):`, subsRes.data?.message);
  }

  // 3. Durcir le bucket 'project-thumbnails'
  console.log("\n3. Sécurisation du bucket 'project-thumbnails' (fileSecurity: true)...");
  const bucketRes = await api('/storage/buckets/project-thumbnails', 'PUT', {
    name: 'Project Thumbnails',
    permissions: [
      'read("any")',
      'create("users")',
      'update("users")',
      'delete("users")',
    ],
    fileSecurity: true,
    maximumFileSize: 10485760, // 10MB
    allowedFileExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  });
  if (bucketRes.ok) {
    console.log("   ✅ Bucket 'project-thumbnails' durci (fileSecurity: true).");
  } else {
    console.warn(`   ⚠️ Erreur mise à jour bucket (${bucketRes.status}):`, bucketRes.data?.message);
  }

  // 4. Durcir la collection 'projects' (Isolation multi-tenant stricte)
  console.log("\n4. Sécurisation de la collection 'projects' (documentSecurity: true, permissions: ['create(\"users\")'])...");
  const projectsRes = await api(`/databases/${DATABASE_ID}/collections/projects`, 'PUT', {
    name: 'Projects',
    permissions: ['create("users")'],
    documentSecurity: true,
  });
  if (projectsRes.ok) {
    console.log("   ✅ Collection 'projects' verrouillée : documentSecurity activé, accès global révoqué.");
  } else {
    console.warn(`   ⚠️ Erreur mise à jour 'projects' (${projectsRes.status}):`, projectsRes.data?.message);
  }

  // 5. Durcir la collection 'project_folders' (Isolation multi-tenant stricte)
  console.log("\n5. Sécurisation de la collection 'project_folders' (documentSecurity: true, permissions: ['create(\"users\")'])...");
  const foldersRes = await api(`/databases/${DATABASE_ID}/collections/project_folders`, 'PUT', {
    name: 'Project Folders',
    permissions: ['create("users")'],
    documentSecurity: true,
  });
  if (foldersRes.ok) {
    console.log("   ✅ Collection 'project_folders' verrouillée : documentSecurity activé, accès global révoqué.");
  } else {
    console.warn(`   ⚠️ Erreur mise à jour 'project_folders' (${foldersRes.status}):`, foldersRes.data?.message);
  }

  console.log('\n=== Durcissement de sécurité Appwrite terminé ! ===');
}

main().catch((err) => {
  console.error('[patch-security-schema] Échec fatal:', err);
  process.exit(1);
});
