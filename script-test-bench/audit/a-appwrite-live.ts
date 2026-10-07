/**
 * Audit A — Test LIVE Appwrite (CRUD projets) avec un compte de test.
 *
 * ⚠ ÉCRIT dans la base de PRODUCTION, mais uniquement des documents nommés `AUDIT-<timestamp>-*`
 *   appartenant au compte de test ; tout est supprimé dans le `finally` (+ balayage AUDIT-*).
 *
 * Usage : npx tsx --env-file=.env script-test-bench/audit/a-appwrite-live.ts [--gpx-dir <dir>]
 * Variables : RV_TEST_EMAIL, RV_TEST_PASSWORD, VITE_APPWRITE_ENDPOINT, VITE_APPWRITE_PROJECT_ID,
 *             VITE_APPWRITE_DATABASE_ID (lues via process.env, jamais affichées).
 * Exit : 0 = tout conforme aux attentes, 1 = anomalie constatée, 2 = identifiants absents, 4 = crash.
 *
 * Reproduit la forme exacte des documents de projectRows.ts:createProject (l.165-186) :
 *   { user_id, folder_id, name, data: 'gz:'+base64, size_bytes, privacy } +
 *   permissions [read/update/delete(user:<id>)], via l'API REST (mêmes routes que le SDK web).
 */
import { performance } from 'node:perf_hooks';

import { compressProjectPayload, decompressProjectPayload } from '../../src/shared/services/projects/compression.ts';
import { computeProjectSizeBytes } from '../../src/shared/services/projects/limits.ts';
import { createDefaultProject } from '../../src/features/itineraryPanel/lib/project/index.ts';
import type { ItineraryProject } from '../../src/features/itineraryPanel/types/index.ts';
import { buildReferenceProjects } from './a-project-size.ts';

const EMAIL = process.env.RV_TEST_EMAIL ?? '';
const PASSWORD = process.env.RV_TEST_PASSWORD ?? '';
const ENDPOINT = (process.env.VITE_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || '').replace(/\/$/, '');
const PROJECT = process.env.VITE_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || '';
const DB = process.env.VITE_APPWRITE_DATABASE_ID || process.env.APPWRITE_DATABASE_ID || 'redview-db';
const COL = 'projects';
const PREFIX = `AUDIT-${Date.now()}`;

if (!EMAIL || !PASSWORD || !ENDPOINT || !PROJECT) {
  console.error(
    '[a-appwrite-live] Identifiants absents : définir RV_TEST_EMAIL, RV_TEST_PASSWORD, ' +
      'VITE_APPWRITE_ENDPOINT, VITE_APPWRITE_PROJECT_ID (ex. `npx tsx --env-file=.env ...`). Rien n\'a été exécuté.',
  );
  process.exit(2);
}

// ── Mini client REST (cookie de session) ─────────────────────────────────
let sessionCookie = '';
let fallbackCookies = '';

interface ApiResult<T = any> { ok: boolean; status: number; data: T; ms: number; bytes: number }  

async function api<T = any>(  
  method: string,
  p: string,
  body?: unknown,
  opts: { anonymous?: boolean; queries?: string[] } = {},
): Promise<ApiResult<T>> {
  const qs = (opts.queries ?? []).map((q) => `queries[]=${encodeURIComponent(q)}`).join('&');
  const headers: Record<string, string> = {
    'X-Appwrite-Project': PROJECT,
    'Content-Type': 'application/json',
    'X-Appwrite-Response-Format': '1.6.0',
  };
  if (!opts.anonymous) {
    if (sessionCookie) headers.Cookie = sessionCookie;
    if (fallbackCookies) headers['X-Fallback-Cookies'] = fallbackCookies;
  }
  const t0 = performance.now();
  const res = await fetch(`${ENDPOINT}${p}${qs ? `?${qs}` : ''}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (p === '/account/sessions/email' && res.ok) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    sessionCookie = setCookies.map((c) => c.split(';')[0]).filter((c) => c.startsWith('a_session_')).join('; ');
    fallbackCookies = res.headers.get('x-fallback-cookies') ?? '';
  }
  let data: any = null;  
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data, ms, bytes: text.length };
}

const Q = {
  equal: (attribute: string, v: unknown) => JSON.stringify({ method: 'equal', attribute, values: [v] }),
  startsWith: (attribute: string, v: string) => JSON.stringify({ method: 'startsWith', attribute, values: [v] }),
  orderDesc: (attribute: string) => JSON.stringify({ method: 'orderDesc', attribute }),
  limit: (n: number) => JSON.stringify({ method: 'limit', values: [n] }),
  select: (values: string[]) => JSON.stringify({ method: 'select', values }),
};

// ── Journal ──────────────────────────────────────────────────────────────
const anomalies: string[] = [];
const log = (step: string, msg: string) => console.log(`  [${step}] ${msg}`);
const expect = (cond: boolean, step: string, okMsg: string, koMsg: string) => {
  if (cond) log(step, `OK — ${okMsg}`);
  else { log(step, `ANOMALIE — ${koMsg}`); anomalies.push(`${step}: ${koMsg}`); }
};
const errSummary = (r: ApiResult) => `${r.status} ${r.data?.type ?? ''} « ${String(r.data?.message ?? r.data).slice(0, 220)} »`;

const createdIds = new Set<string>();
let userId = '';

async function createDoc(name: string, project: ItineraryProject, permissionsFor = userId, ownerField = userId) {
  const data = await compressProjectPayload(project);
  const r = await api('POST', `/databases/${DB}/collections/${COL}/documents`, {
    documentId: 'unique()',
    data: {
      user_id: ownerField,
      folder_id: null,
      name,
      data,
      size_bytes: computeProjectSizeBytes(project),
      privacy: project.privacy ?? 'private',
    },
    permissions: [
      `read("user:${permissionsFor}")`,
      `update("user:${permissionsFor}")`,
      `delete("user:${permissionsFor}")`,
    ],
  });
  if (r.ok) createdIds.add(r.data.$id);
  return { r, chars: data.length };
}

async function main() {
  console.log(`\n=== Audit A — Appwrite LIVE (${ENDPOINT}, projet ${PROJECT}, base ${DB}) préfixe ${PREFIX} ===`);

  // 1. Connexion
  const login = await api('POST', '/account/sessions/email', { email: EMAIL, password: PASSWORD });
  if (!login.ok) {
    console.error(`  Connexion impossible : ${errSummary(login)}`);
    process.exit(1);
  }
  const me = await api('GET', '/account');
  if (!me.ok) {
    console.error(`  /account KO après login (cookie non transmis ?) : ${errSummary(me)}`);
    process.exit(1);
  }
  userId = me.data.$id;
  log('login', `session ouverte (${login.ms} ms), utilisateur ${userId.slice(0, 6)}…`);

  const refs = buildReferenceProjects();
  if (!refs) console.warn('  (GT20.gpx absent : scénarios lourds ignorés ; passer --gpx-dir)');

  try {
    // 2. Création (forme identique à createProject)
    const small = { ...createDefaultProject(), name: `${PREFIX}-small` };
    const c1 = await createDoc(`${PREFIX}-small`, small);
    expect(c1.r.ok, 'create', `document créé en ${c1.r.ms} ms (${c1.chars} car.)`, `création refusée : ${errSummary(c1.r)}`);
    if (!c1.r.ok) return;
    const docId = c1.r.data.$id;

    // 3a. Mise à jour sous la limite (trace GT20 seule)
    if (refs) {
      const traceData = await compressProjectPayload(refs.traceOnly);
      const u = await api('PATCH', `/databases/${DB}/collections/${COL}/documents/${docId}`, {
        data: { name: `${PREFIX}-small`, data: traceData, size_bytes: computeProjectSizeBytes(refs.traceOnly), privacy: 'private' },
      });
      expect(u.ok, 'update<limit', `${traceData.length} car. acceptés en ${u.ms} ms`, `refusé : ${errSummary(u)}`);

      // 4. Relecture et comparaison
      const g = await api('GET', `/databases/${DB}/collections/${COL}/documents/${docId}`);
      const back = g.ok ? await decompressProjectPayload(g.data.data) : null;
      expect(
        !!back && JSON.stringify(back) === JSON.stringify(refs.traceOnly),
        'read-back',
        `relu en ${g.ms} ms, ${g.bytes} octets, contenu identique`,
        `contenu différent ou illisible (${g.status})`,
      );

      // 3b. Projets lourds réalistes (GT20 + 1000 POI + prédiction, puis 3 variantes) : attendu = accepté
      for (const [label, project] of [['heavy', refs.heavy], ['ultra', refs.ultra]] as const) {
        const payload = await compressProjectPayload(project);
        const uh = await api('PATCH', `/databases/${DB}/collections/${COL}/documents/${docId}`, {
          data: { data: payload, size_bytes: computeProjectSizeBytes(project) },
        });
        expect(
          uh.ok,
          `update-${label}`,
          `${payload.length} car. (JSON ${computeProjectSizeBytes(project)} o) acceptés en ${uh.ms} ms`,
          `${payload.length} car. refusés : ${errSummary(uh)}`,
        );
        if (uh.ok) {
          const g = await api('GET', `/databases/${DB}/collections/${COL}/documents/${docId}`);
          const back = g.ok ? await decompressProjectPayload(g.data.data) : null;
          expect(
            !!back && JSON.stringify(back) === JSON.stringify(project),
            `read-back-${label}`,
            `relu en ${g.ms} ms, contenu identique`,
            `contenu différent ou illisible (${g.status})`,
          );
        }
      }
    }

    // 3c. Bornes : plafond applicatif 12 M car. (le nginx devant Appwrite renvoie 502 vers 16 M),
    //     attribut schéma 16 000 000 car. → au-delà, refus attendu.
    for (const [n, expectOk] of [[12_000_000, true], [16_000_001, false]] as const) {
      const u = await api('PATCH', `/databases/${DB}/collections/${COL}/documents/${docId}`, { data: { data: 'x'.repeat(n) } });
      log('borne', `data de ${n} car. → HTTP ${u.status}${u.ok ? '' : ` ${u.data?.type ?? ''}`} (${u.ms} ms)`);
      expect(
        expectOk ? u.ok : !u.ok,
        'borne',
        `${n} car. ${u.ok ? 'accepté' : 'refusé'} comme attendu`,
        `${n} car. ${u.ok ? 'accepté' : `refusé (${String(errSummary(u)).replace(/\s+/g, ' ').slice(0, 120)})`} — inattendu`,
      );
    }

    // 5. Renommage (comme renameProject : name + data)
    const renamed = { ...small, name: `${PREFIX}-renamed` };
    const rn = await api('PATCH', `/databases/${DB}/collections/${COL}/documents/${docId}`, {
      data: { name: renamed.name, data: await compressProjectPayload(renamed), size_bytes: computeProjectSizeBytes(renamed) },
    });
    expect(rn.ok && rn.data.name === renamed.name, 'rename', `renommé (${rn.ms} ms)`, `échec : ${errSummary(rn)}`);

    // 6. Duplication (createProject avec données initiales)
    const dup = await createDoc(`${PREFIX}-copy`, { ...renamed, name: `${PREFIX}-copy` });
    expect(dup.r.ok, 'duplicate', `copie créée ${dup.r.data?.$id?.slice(0, 6)}…`, `échec : ${errSummary(dup.r)}`);
    if (refs) {
      const dupHeavy = await createDoc(`${PREFIX}-copy-heavy`, { ...refs.heavy, name: `${PREFIX}-copy-heavy` });
      log('duplicate-heavy', `copie d'un projet lourd → HTTP ${dupHeavy.r.status}${dupHeavy.r.ok ? '' : ` ${errSummary(dupHeavy.r)}`} → en prod createProject retombe en « local-* » sans erreur`);
    }

    // 7. Accès anonyme
    const anonGet = await api('GET', `/databases/${DB}/collections/${COL}/documents/${docId}`, undefined, { anonymous: true });
    expect(!anonGet.ok, 'anon-get', `refusé (${anonGet.status})`, `DOCUMENT LISIBLE SANS SESSION (${anonGet.status})`);
    const anonList = await api('GET', `/databases/${DB}/collections/${COL}/documents`, undefined, {
      anonymous: true, queries: [Q.limit(5)],
    });
    const anonCount = anonList.ok ? anonList.data.documents?.length ?? 0 : 0;
    expect(anonCount === 0, 'anon-list', `0 document visible (${anonList.status})`, `${anonCount} document(s) visibles anonymement`);
    const anonUpd = await api('PATCH', `/databases/${DB}/collections/${COL}/documents/${docId}`, { data: { name: 'pwned' } }, { anonymous: true });
    expect(!anonUpd.ok, 'anon-update', `refusé (${anonUpd.status})`, `MODIFICATION ANONYME ACCEPTÉE`);

    // 8. Écriture au nom d'un autre utilisateur
    const spoof = await createDoc(`${PREFIX}-spoof`, { ...small, name: `${PREFIX}-spoof` }, 'audit-other-user-000', 'audit-other-user-000');
    expect(!spoof.r.ok, 'spoof-perms', `permissions pour un autre user refusées (${spoof.r.status} ${spoof.r.data?.type ?? ''})`, 'document créé avec des permissions pour un autre utilisateur');
    const spoofOwner = await createDoc(`${PREFIX}-spoof-owner`, { ...small, name: `${PREFIX}-spoof-owner` }, userId, 'audit-other-user-000');
    log('spoof-user_id', `user_id falsifié + permissions sur soi → HTTP ${spoofOwner.r.status} (accepté = le champ user_id n'est pas contrôlé serveur ; sans effet de lecture croisée car documentSecurity filtre)`);
    const pub = await api('POST', `/databases/${DB}/collections/${COL}/documents`, {
      documentId: 'unique()',
      data: { user_id: userId, folder_id: null, name: `${PREFIX}-public`, data: '{}', size_bytes: 2, privacy: 'public' },
      // update/delete sur soi : sinon le document est impossible à supprimer par le compte de test.
      permissions: ['read("any")', `update("user:${userId}")`, `delete("user:${userId}")`],
    });
    if (pub.ok) createdIds.add(pub.data.$id);
    log('read-any', `document read("any") créé par le client → HTTP ${pub.status} (accepté = un utilisateur peut rendre un document public)`);

    // 9. Coût de listProjects (requête exacte de projectRows.ts:81-89) vs Query.select
    const full = await api('GET', `/databases/${DB}/collections/${COL}/documents`, undefined, {
      queries: [Q.equal('user_id', userId), Q.orderDesc('$updatedAt'), Q.limit(100)],
    });
    const sel = await api('GET', `/databases/${DB}/collections/${COL}/documents`, undefined, {
      queries: [Q.equal('user_id', userId), Q.orderDesc('$updatedAt'), Q.limit(100),
        Q.select(['$id', 'name', 'folder_id', 'privacy', 'size_bytes', '$createdAt', '$updatedAt'])],
    });
    log('list', `listProjects actuel : ${full.data?.documents?.length ?? '?'} docs, ${full.bytes} octets, ${full.ms} ms | avec Query.select : ${sel.bytes} octets, ${sel.ms} ms (HTTP ${sel.status})`);

    // 10. deleteProjectFolder : listDocuments sans limit → défaut
    const noLimit = await api('GET', `/databases/${DB}/collections/${COL}/documents`, undefined, {
      queries: [Q.equal('folder_id', '__audit_none__')],
    });
    log('folder-query', `Query.equal('folder_id') sans index ni limit → HTTP ${noLimit.status}${noLimit.ok ? '' : ` ${errSummary(noLimit)}`}`);
  } finally {
    // Nettoyage : ids suivis + balayage AUDIT-* du compte de test
    const sweep = await api('GET', `/databases/${DB}/collections/${COL}/documents`, undefined, {
      queries: [Q.startsWith('name', 'AUDIT-'), Q.limit(100)],
    });
    for (const d of sweep.ok ? sweep.data.documents ?? [] : []) {
      if (String(d.name).startsWith('AUDIT-')) createdIds.add(d.$id);
    }
    let deleted = 0;
    for (const id of createdIds) {
      const d = await api('DELETE', `/databases/${DB}/collections/${COL}/documents/${id}`);
      if (d.ok || d.status === 404) deleted++;
      else console.warn(`  [cleanup] échec suppression ${id} : ${errSummary(d)}`);
    }
    log('cleanup', `${deleted}/${createdIds.size} document(s) AUDIT-* supprimé(s)`);
    await api('DELETE', '/account/sessions/current');
  }

  console.log(`\n=== ${anomalies.length ? `${anomalies.length} anomalie(s)` : 'aucune anomalie'} ===`);
  for (const a of anomalies) console.log(`  - ${a}`);
  process.exitCode = anomalies.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(4);
});
