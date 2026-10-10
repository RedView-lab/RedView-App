/**
 * Audit A — Simulation hors-ligne de la persistance projet (pistes C1, C2, C4, C5, R2, P1, P2).
 *
 * Bundle avec esbuild le VRAI code :
 *   src/shared/services/projects/{projectRows,folders,compression}.ts + src/shared/services/appwrite.ts
 * en remplaçant uniquement :
 *   - le paquet `appwrite` (SDK web)        → src/shared/test/mockAppwriteSdk.ts (data ≤ 16 M car., proxy nginx 502 au-delà, limit 25 par défaut)
 *   - shared/services/storage/idbProjectStore  → a-mock-idb.ts (IndexedDB en mémoire)
 * `window.localStorage` est simulé. Aucun accès réseau.
 *
 * Usage : npx tsx script-test-bench/audit/a-persistence-sim.ts
 * Exit 1 si au moins un scénario de perte de données est reproduit.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

// ── window / localStorage factices (avant chargement du bundle) ──────────
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) {
    if (v.length > 5_000_000) {
      const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
    }
    this.m.set(k, String(v));
  }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.localStorage = new MemStorage();
// Événements window minimalistes (online, pagehide…) pour le hook d'autosave (scénarios H*).
const winListeners = new Map<string, Set<(ev: unknown) => void>>();
g.addEventListener = (type: string, fn: (ev: unknown) => void) => {
  if (!winListeners.has(type)) winListeners.set(type, new Set());
  winListeners.get(type)!.add(fn);
};
g.removeEventListener = (type: string, fn: (ev: unknown) => void) => { winListeners.get(type)?.delete(fn); };
g.dispatchEvent = (ev: { type: string }) => { for (const fn of winListeners.get(ev.type) ?? []) fn(ev); return true; };
g.document = {
  visibilityState: 'visible',
  title: '',
  documentElement: { lang: 'fr' },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
g.location = { pathname: '/' };
g.history = { replaceState: (_s: unknown, _t: string, path: string) => { (g.location as { pathname: string }).pathname = path; } };

let bundleCount = 0;
async function loadBundle() {
  const esbuild = await import('esbuild');
  // Un fichier par chargement : chaque onglet (scénarios T*) a son propre graphe de modules.
  const outFile = path.join(os.tmpdir(), `rv-audit-persist-${process.pid}-${++bundleCount}.mjs`);
  const entry = `
    export * from ${JSON.stringify(path.join(SRC, 'shared/services/projects/projectRows.ts'))};
    export * from ${JSON.stringify(path.join(SRC, 'shared/services/projects/projectViews.ts'))};
    export * from ${JSON.stringify(path.join(SRC, 'shared/services/projects/folders.ts'))};
    export { getSavedCustomProfiles, saveCustomProfileToStorage, deleteCustomProfileFromStorage, syncCustomProfilesWithAccount } from ${JSON.stringify(path.join(SRC, 'features/itineraryPanel/lib/project/customProfiles.ts'))};
    export { extractProjectView, toProjectDocument, isProjectDocument } from ${JSON.stringify(path.join(SRC, 'features/itineraryPanel/lib/project/layers.ts'))};
    export { compressProjectPayload, decompressProjectPayload } from ${JSON.stringify(path.join(SRC, 'shared/services/projects/compression.ts'))};
    export { readStoredAppwriteSession, saveStoredAppwriteSession, clearStoredAppwriteSession, getAppwriteUser } from ${JSON.stringify(path.join(SRC, 'shared/services/appwrite.ts'))};
    export { createDefaultProject, createDefaultItinerary } from ${JSON.stringify(path.join(SRC, 'features/itineraryPanel/lib/project/index.ts'))};
    export { useDashboardProjectSync } from ${JSON.stringify(path.join(SRC, 'pages/Dashboard/hooks/useDashboardProjectSync.ts'))};
    export { signOutAccount } from ${JSON.stringify(path.join(SRC, 'features/projectBrowser/account/lib/profile.ts'))};
    export { getProjectSyncStatus } from ${JSON.stringify(path.join(SRC, 'shared/services/projects/syncStatus.ts'))};
    export { __mock } from 'appwrite';
    export { __idb } from '@/shared/services/storage/idbProjectStore';
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'error',
    define: { 'import.meta.env': '{"DEV":false,"VITE_APPWRITE_ENDPOINT":"https://appwrite.mock/v1"}', __REDVIEW_BUILD_ID__: '"audit"' },
    plugins: [{
      name: 'audit-mocks',
      setup(build) {
        build.onResolve({ filter: /^appwrite$/ }, () => ({ path: path.join(import.meta.dirname, '..', '..', 'src', 'shared', 'test', 'mockAppwriteSdk.ts') }));
        build.onResolve({ filter: /^react$/ }, () => ({ path: path.join(import.meta.dirname, 'a-mock-react.ts') }));
        build.onResolve({ filter: /idbProjectStore$/ }, () => ({ path: path.join(import.meta.dirname, 'a-mock-idb.ts') }));
        build.onResolve({ filter: /^@\// }, (args) =>
          build.resolve('./' + args.path.slice(2), { resolveDir: SRC, kind: args.kind }));
        // La synchronisation attendable des profils est interne au module (l'app ne
        // passe que par ensureCustomProfilesSynced, sans attente) : exposée ici, dans
        // le bundle du harnais seulement, pour que le scénario PR1 puisse l'attendre.
        build.onLoad({ filter: /[\\/]customProfiles\.ts$/ }, (args) => ({
          contents: `${fs.readFileSync(args.path, 'utf8')}\nexport { syncCustomProfilesWithAccount };\n`,
          loader: 'ts',
          resolveDir: path.dirname(args.path),
        }));
      },
    }],
  });
  const mod = await import(`file:///${outFile.replace(/\\/g, '/')}`);
  fs.rmSync(outFile, { force: true });
  return mod as Record<string, any>;  
}

type Result = { id: string; title: string; reproduced: boolean; details: string[] };
const results: Result[] = [];
function report(id: string, title: string, reproduced: boolean, details: string[]) {
  results.push({ id, title, reproduced, details });
  console.log(`\n[${reproduced ? 'REPRODUIT' : 'non reproduit'}] ${id} — ${title}`);
  for (const d of details) console.log(`   ${d}`);
}

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

async function main() {
  const m = await loadBundle();
  const { __mock, __idb } = m;
  const loginAs = (userId: string) => {
    __mock.user = { $id: userId, email: `${userId}@example.test`, name: userId };
    m.saveStoredAppwriteSession({ id: userId, email: `${userId}@example.test` });
  };
  const fresh = () => {
    __mock.reset();
    __idb.clear();
    (g.localStorage as MemStorage).clear();
    loginAs('user-A');
  };
  const cloudProject = async (id: string) => {
    const doc = __mock.col('projects').get(id);
    return doc ? await m.decompressProjectPayload(doc.data) : null;
  };
  const named = (name: string, extra: Record<string, unknown> = {}) => ({ ...m.createDefaultProject(), name, ...extra });
  /** Projet ~3,5 Mo JSON dont le gz+base64 dépasse 1 000 000 car. (flottants peu compressibles). */
  const heavy = (name: string) => {
    const it = m.createDefaultItinerary(1);
    const pts = Array.from({ length: 55_000 }, (_, i) => ({
      lat: 45 + rnd() * 0.5, lon: 6 + rnd() * 0.5, distanceM: i * 11.3 + rnd(), elevationM: 800 + rnd() * 1500,
    }));
    it.gpxRoute = { name, points: pts.slice(0, 7000), originalPoints: pts, source: 'gpx' };
    return { ...m.createDefaultProject(), name, itineraries: [it], activeItineraryId: it.id };
  };

  // ── C1a : autosave d'un projet devenu trop gros pour Appwrite ──────────
  // Refus serveur simulé avec l'ancien schéma (data ≤ 1 000 000 car.) : toute erreur
  // 400 d'Appwrite doit remonter à l'appelant.
  {
    fresh();
    __mock.dataMaxChars = 1_000_000;
    const row = await m.createProject('C1 ultra', named('C1 ultra'));
    const big = heavy('C1 ultra — 3 semaines d\'édition');
    const json = JSON.stringify(big).length;
    const gz = (await m.compressProjectPayload(big)).length;
    let threw: unknown = null;
    try { await m.saveProject(row.id, big); } catch (e) { threw = e; }
    const cloud = await cloudProject(row.id);
    const idbHasHeavy = (__idb.projects.get(row.id)?.data?.itineraries?.length ?? 0) === 1;
    __idb.clear(); // déconnexion : profile.ts:244 clearProjectStore()
    const afterLogout = await m.getProject(row.id);
    const lost = !afterLogout?.data?.itineraries?.length;
    report('C1a', 'saveProject avale le refus Appwrite (data > 1 000 000 car.)', !threw && lost, [
      `projet JSON=${(json / 1e6).toFixed(2)} Mo (< 16 MiB client), gz+b64=${gz} car. (> 1 000 000)`,
      `saveProject a levé une erreur ? ${threw ? 'oui' : 'NON (résout normalement → flushSave/saveNow enregistrent un succès)'}`,
      `cloud après save : itinéraires=${cloud?.itineraries?.length ?? 0} (inchangé) ; IndexedDB : ${idbHasHeavy ? 'version lourde présente' : 'absente'}`,
      `après déconnexion (IDB purgée) puis réouverture : itinéraires=${afterLogout?.data?.itineraries?.length ?? 0} → ${lost ? 'TOUTES LES MODIFS PERDUES' : 'ok'}`,
    ]);
  }

  // ── C1b : duplication / création d'un gros projet → projet local- invisible ──
  {
    fresh();
    __mock.dataMaxChars = 1_000_000; // refus serveur (ancien schéma) pendant la duplication
    const big = heavy('Copie de GT20');
    // Comportement attendu après correctif : createProject lève (toast d'erreur) au lieu
    // de renvoyer silencieusement un projet `local-*`.
    let row: { id: string } | null = null;
    let threw: unknown = null;
    try { row = await m.createProject('Copie de GT20', big, null); } catch (e) { threw = e; }
    const list = await m.listProjects();
    const visible = !!row && list.some((p: { id: string }) => p.id === row!.id);
    const silentLocal = !!row && row.id.startsWith('local-') && !visible;
    report('C1b', 'createProject (dupliquer) d\'un gros projet retombe en « local-* » jamais synchronisé', silentLocal, [
      row ? `id renvoyé : ${row.id} (aucune erreur, toast « Projet dupliqué » affiché par useProjectBrowserProjects.ts:403)` : `createProject a levé : ${(threw as Error)?.name} ${(threw as { kind?: string })?.kind ?? ''} → toast d'erreur, aucun projet fantôme`,
      `listProjects() (cloud OK) contient le projet ? ${visible ? 'oui' : 'non'}`,
    ]);
  }

  // ── C1e : charge utile compressée > 12 M car. (limite nginx) → fichier du bucket `project-payloads` ──
  // (payloadFiles.ts : nouveau fichier à chaque sauvegarde, document pointé dessus, anciens fichiers supprimés.)
  {
    fresh();
    const row = await m.createProject('C1e', named('C1e'));
    // ~15 Mo de texte quasi incompressible (< 16 MiB brut, gz+b64 > 12 M car.)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chunk = Array.from({ length: 1_000_000 }, () => alphabet[Math.floor(rnd() * 62)]).join('');
    const blob = Array.from({ length: 15 }, (_, i) => chunk.slice(i * 997) + chunk.slice(0, i * 997)).join('');
    const huge = { ...named('C1e énorme'), auditBlob: blob };
    const rawBytes = Buffer.byteLength(JSON.stringify(huge));
    let threw: { kind?: string; message?: string } | null = null;
    try { await m.saveProject(row.id, huge); } catch (e) { threw = e as { kind?: string; message?: string }; }
    const firstData = __mock.col('projects').get(row.id)?.data;
    const pointer = typeof firstData === 'string' && firstData.startsWith('file:');
    // Deuxième sauvegarde : nouveau fichier, puis l'ancien supprimé (aucun orphelin).
    try { await m.saveProject(row.id, { ...huge, name: 'C1e énorme v2' }); } catch (e) { threw ??= e as { kind?: string; message?: string }; }
    const files = [...__mock.files.values()].filter((file: { name: string }) => file.name === `${row.id}.json.gz`).length;
    // Autre appareil (pas de copie IndexedDB) : le projet revient entier du bucket.
    __idb.clear();
    const reopened = await m.getProject(row.id);
    const whole = reopened?.data?.name === 'C1e énorme v2' && reopened?.data?.auditBlob === blob;
    const bad = threw !== null || !pointer || __mock.proxyRejections > 0 || files !== 1 || !whole;
    report('C1e', 'gros projet (gzip > 12 M car.) : refusé, perdu, orphelin ou relu incomplet au lieu du bucket', bad, [
      `brut=${(rawBytes / 1e6).toFixed(2)} Mo ; saveProject : ${threw ? `lève ${threw.kind} « ${threw.message?.slice(0, 60)}… »` : 'résout'} ; document : ${pointer ? 'pointeur file:' : `data inline (${String(firstData).slice(0, 20)}…)`}`,
      `502 du proxy : ${__mock.proxyRejections} ; fichiers du projet après 2 sauvegardes : ${files} (1 attendu)`,
      `relu sur un autre appareil : ${whole ? 'entier (nom v2, 15 Mo identiques)' : `INCOMPLET (nom=${reopened?.data?.name})`}`,
    ]);
  }

  // ── T1 / T2 : deux onglets (deux bundles = deux graphes de modules, même faux
  // Appwrite et même IndexedDB) qui enregistrent le même projet en même temps.
  // L'onglet Y écrit après le contrôle de version de X, avant son écriture (B3-1, B3-2).
  {
    fresh();
    const row = await m.createProject('T1', named('T1'));
    const tabY = await loadBundle();
    await tabY.getProject(row.id);
    __mock.beforeProjectWrite = () => tabY.saveProject(row.id, named('T1 onglet Y'));
    let outcome = 'résout';
    try { await m.saveProject(row.id, named('T1 onglet X')); } catch (e) { outcome = `lève ${(e as { kind?: string }).kind}`; }
    const cloudName = __mock.col('projects').get(row.id)?.name;
    report('T1', 'deux onglets enregistrent en même temps : écrasement silencieux (pas de conflit)', outcome !== 'lève conflict' || cloudName !== 'T1 onglet Y', [
      `sauvegarde de X : ${outcome} (conflit attendu) ; nom dans le cloud : « ${cloudName} » (attendu : celui de Y)`,
    ]);
  }
  {
    fresh();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chunk = Array.from({ length: 1_000_000 }, () => alphabet[Math.floor(rnd() * 62)]).join('');
    const blob = Array.from({ length: 15 }, (_, i) => chunk.slice(i * 997) + chunk.slice(0, i * 997)).join('');
    const row = await m.createProject('T2', { ...named('T2'), auditBlob: blob });
    const tabY = await loadBundle();
    await tabY.getProject(row.id);
    __mock.beforeProjectWrite = () => tabY.saveProject(row.id, { ...named('T2 onglet Y'), auditBlob: blob });
    let outcome = 'résout';
    try { await m.saveProject(row.id, { ...named('T2 onglet X'), auditBlob: blob }); } catch (e) { outcome = `lève ${(e as { kind?: string }).kind}`; }
    const data = String(__mock.col('projects').get(row.id)?.data ?? '');
    const pointed = data.startsWith('file:') && __mock.files.has(data.slice('file:'.length));
    const files = [...__mock.files.values()].filter((file: { name: string }) => file.name === `${row.id}.json.gz`).length;
    // Troisième appareil (aucune copie locale, nouvel onglet) : le projet se relit-il ?
    __idb.clear();
    const tabZ = await loadBundle();
    let reopened = '—';
    try { reopened = (await tabZ.getProject(row.id))?.data?.name ?? 'introuvable'; } catch (e) { reopened = `erreur ${(e as { kind?: string }).kind}`; }
    report('T2', 'gros projet enregistré par deux onglets : document pointé sur un fichier supprimé', !pointed || files !== 1 || reopened !== 'T2 onglet Y', [
      `sauvegarde de X : ${outcome} ; fichier pointé présent : ${pointed ? 'oui' : 'NON'} ; fichiers du projet : ${files} (1 attendu)`,
      `relu sur un troisième appareil : ${reopened}`,
    ]);
  }

  // ── C1c / C1d : suppression / renommage pendant une coupure réseau ──
  {
    fresh();
    const row = await m.createProject('Zombie', named('Zombie'));
    await m.getProject(row.id);
    __mock.dbNetworkDown = true;
    let threwDel: unknown = null; let threwRen: unknown = null;
    try { await m.renameProject(row.id, 'Nouveau nom'); } catch (e) { threwRen = e; }
    try { await m.deleteProject(row.id); } catch (e) { threwDel = e; }
    __mock.dbNetworkDown = false;
    const list = await m.listProjects();
    const back = list.find((p: { id: string }) => p.id === row.id);
    report('C1c', 'deleteProject / renameProject : échec cloud silencieux', !threwDel && !threwRen && !!back && back.name === 'Zombie', [
      `rename levé ? ${threwRen ? 'oui' : 'non'} ; delete levé ? ${threwDel ? 'oui (toast d\'erreur, projet conservé)' : 'non (UI : succès, projet retiré de la liste)'}`,
      `au refresh : projet ${back ? `RÉAPPARAÎT, nom="${back.name}"` : 'absent'}`,
    ]);
  }

  // ── R1 : suppression d'un projet → ses fichiers FIT (RGPD), et seulement les siens ──
  {
    fresh();
    const fitProject = (name: string, fileId: string) => {
      const it = m.createDefaultItinerary(1);
      it.fitUploads = [{ path: fileId, name: `${fileId}.fit`, size: 3, type: 'application/octet-stream', lastModified: 0 }];
      return { ...m.createDefaultProject(), name, itineraries: [it], activeItineraryId: it.id };
    };
    for (const id of ['fitA', 'fitB']) {
      __mock.files.set(id, { bucket: 'itinerary-fit-files', name: `${id}.fit`, bytes: new Uint8Array(3), permissions: [] });
    }
    const a = await m.createProject('Avec FIT', fitProject('Avec FIT', 'fitA'));
    await m.createProject('Autre', fitProject('Autre', 'fitB'));
    await m.deleteProject(a.id);
    const ownGone = !__mock.files.has('fitA');
    const otherKept = __mock.files.has('fitB');
    report('R1', 'RGPD : fichiers FIT laissés après la suppression du projet (ou ceux d\'un autre effacés)', !ownGone || !otherKept, [
      `fichier du projet supprimé : ${ownGone ? 'effacé' : 'TOUJOURS DANS LE BUCKET'} ; fichier d'un autre projet : ${otherKept ? 'gardé' : 'EFFACÉ À TORT'}`,
    ]);
  }

  // ── C2 : coupure réseau transitoire pendant un autosave → fallback dev-user-001 ──
  {
    fresh();
    const row = await m.createProject('C2', named('C2 v1'));
    await m.getProject(row.id);
    __mock.calls = [];
    __mock.accountGetMode = 'network';
    __mock.accountGetFailures = 1; // un seul échec réseau (wifi qui décroche 1 s)
    await m.saveProject(row.id, named('C2 v2 (modifs utilisateur)'));
    const accountGetCalls = __mock.calls.filter((c: string) => c === 'account.get').length;
    const idbOwner = __idb.projects.get(row.id)?.user_id;
    const sessionAfter = m.readStoredAppwriteSession();
    const cloudName = (await cloudProject(row.id))?.name;
    // Pendant la coupure, la liste du navigateur de projets :
    __mock.accountGetMode = 'network'; __mock.accountGetFailures = -1;
    const listDuringOutage = await m.listProjects();
    __mock.accountGetMode = 'ok';
    const reopened = await m.getProject(row.id);
    const lost = reopened?.data?.name !== 'C2 v2 (modifs utilisateur)';
    report('C2', 'échec réseau de account.get() → userId « dev-user-001 » → sauvegarde orpheline', lost, [
      `appels : ${accountGetCalls} account.get() pour 1 saveProject (1 aller-retour réseau par autosave)`,
      `session locale après l'erreur réseau : ${sessionAfter ? 'conservée' : 'EFFACÉE (appwrite.ts:102-104 clearStoredAppwriteSession sur toute erreur)'}`,
      `ligne IndexedDB réécrite avec user_id="${idbOwner}" ; cloud.name="${cloudName}" (pas d'envoi cloud)`,
      `liste des projets pendant la coupure : ${listDuringOutage.length} projet(s) [${listDuringOutage.map((p: { name: string }) => p.name).join(', ')}] — les vrais projets de l'utilisateur ont disparu`,
      `réseau rétabli, réouverture : name="${reopened?.data?.name}" → ${lost ? 'MODIFS PERDUES (ligne IDB ignorée car user_id≠user-A, cloud ancien)' : 'ok'}`,
    ]);
  }

  // ── C2b : seul un vrai 401 invalide la session ; sans utilisateur, aucune écriture factice ──
  {
    fresh();
    const expired: unknown[] = [];
    // Canal écouté par l'app (App.tsx) : l'événement window « redview:session-expired ».
    const onExpired = (ev: unknown) => expired.push((ev as { detail?: unknown }).detail);
    (g.addEventListener as (type: string, fn: (ev: unknown) => void) => void)('redview:session-expired', onExpired);
    const off = () => (g.removeEventListener as (type: string, fn: (ev: unknown) => void) => void)('redview:session-expired', onExpired);
    __mock.accountGetMode = 'network'; __mock.accountGetFailures = -1;
    await m.getAppwriteUser();
    const keptAfterNetwork = !!m.readStoredAppwriteSession();
    __mock.accountGetMode = 'unauthorized';
    await m.getAppwriteUser();
    const clearedAfter401 = !m.readStoredAppwriteSession();
    // Plus aucune session (prod, DEV=false) : saveProject doit lever, sans ligne « dev-user-001 ».
    __idb.clear();
    let threw: { kind?: string } | null = null;
    try { await m.saveProject('doc-x', named('orphelin')); } catch (e) { threw = e as { kind?: string }; }
    const fakeOwnerRows = [...__idb.projects.values()].filter((r: { user_id: string }) => r.user_id === 'dev-user-001').length;
    off();
    __mock.accountGetMode = 'ok';
    const bad = !keptAfterNetwork || !clearedAfter401 || expired.length !== 1 || !threw || fakeOwnerRows > 0;
    report('C2b', 'session : effacée sur erreur réseau / écritures sous un propriétaire factice', bad, [
      `après erreur réseau : session ${keptAfterNetwork ? 'conservée' : 'EFFACÉE'} ; après 401 : ${clearedAfter401 ? 'effacée' : 'CONSERVÉE'} ; événements d'expiration : ${expired.length}`,
      `saveProject sans session : ${threw ? `lève (${threw.kind})` : 'RÉSOUT'} ; lignes IDB sous dev-user-001 : ${fakeOwnerRows}`,
    ]);
  }

  // ── C4 : copie IndexedDB prioritaire sur le cloud → un appareil périmé écrase ──
  {
    fresh();
    const row = await m.createProject('C4', named('C4 v1'));
    await m.getProject(row.id); // appareil A : copie IDB v1 (ouverture précédente)
    // appareil B (autre navigateur) enregistre v2 dans le cloud
    const v2 = named('C4 v2 (édité sur le portable)');
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(v2));
    // appareil A rouvre le projet
    const opened = await m.getProject(row.id);
    await m.saveProject(row.id, { ...opened.data, name: `${opened.data.name} + petite modif` });
    const final = await cloudProject(row.id);
    const lost = !String(final?.name).includes('v2');
    report('C4', 'getProject sert la copie IndexedDB sans comparer $updatedAt → écrasement multi-appareils', lost, [
      `appareil A ouvre : "${opened.data.name}" (cloud contenait "C4 v2 …") — aucun getDocument : ${!__mock.calls.includes('getDocument:projects') ? 'aucun appel cloud' : 'appel cloud'}`,
      `après le 1er autosave de A, cloud = "${final?.name}" → ${lost ? 'VERSION v2 DÉTRUITE' : 'ok'}`,
    ]);
  }

  // ── C4b : session ouverte sur v1, un autre appareil enregistre v2 → la sauvegarde ne doit pas écraser ──
  {
    fresh();
    const row = await m.createProject('C4b', named('C4b v1'));
    await m.getProject(row.id);
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(named('C4b v2 (portable)')));
    let threw: { kind?: string } | null = null;
    try { await m.saveProject(row.id, named('C4b v1 + modif bureau')); } catch (e) { threw = e as { kind?: string }; }
    const cloudAfterConflict = (await cloudProject(row.id))?.name;
    const idbRow = __idb.projects.get(row.id);
    // Choix explicite de l'utilisateur : écraser.
    await m.saveProject(row.id, named('C4b v1 + modif bureau'), { force: true });
    const cloudAfterForce = (await cloudProject(row.id))?.name;
    const idbAfterForce = __idb.projects.get(row.id);
    const bad = threw?.kind !== 'conflict' || cloudAfterConflict !== 'C4b v2 (portable)' || !idbRow?.dirty
      || idbRow?.data?.name !== 'C4b v1 + modif bureau' || cloudAfterForce !== 'C4b v1 + modif bureau' || idbAfterForce?.dirty;
    report('C4b', 'sauvegarde aveugle par-dessus une version plus récente d\'un autre appareil', bad, [
      `saveProject : ${threw ? `lève ${threw.kind}` : 'RÉSOUT'} ; cloud après refus = "${cloudAfterConflict}"`,
      `copie locale conservée en attente : dirty=${idbRow?.dirty} name="${idbRow?.data?.name}"`,
      `après force (choix utilisateur) : cloud="${cloudAfterForce}", dirty=${idbAfterForce?.dirty}`,
    ]);
  }

  // ── C4c : modifs locales non synchronisées (onglet fermé hors-ligne) → reprises à l'ouverture ──
  {
    fresh();
    const row = await m.createProject('C4c', named('C4c v1'));
    await m.getProject(row.id);
    __mock.dbNetworkDown = true;
    let threw: unknown = null;
    try { await m.saveProject(row.id, named('C4c v2 hors-ligne')); } catch (e) { threw = e; }
    __mock.dbNetworkDown = false;
    const dirtyBefore = (await m.listDirtyProjects()).map((p: { id: string }) => p.id);
    const reopened = await m.getProject(row.id);
    await m.saveProject(row.id, reopened.data);
    const cloudName = (await cloudProject(row.id))?.name;
    const dirtyAfter = (await m.listDirtyProjects()).length;
    // Cas conflit : modifs locales non synchronisées ET cloud modifié ailleurs (plus récent).
    __mock.dbNetworkDown = true;
    try { await m.saveProject(row.id, named('C4c v3 locale')); } catch { /* attendu */ }
    __mock.dbNetworkDown = false;
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(named('C4c v4 portable')), 'C4c v4 portable');
    const opened = await m.getProject(row.id);
    const all = [...__mock.col('projects').values()];
    const copies = await Promise.all(all.filter((d: { $id: string }) => d.$id !== row.id).map((d: { $id: string }) => cloudProject(d.$id)));
    const localKept = copies.some((p: { name?: string } | null) => String(p?.name).startsWith('C4c v3 locale'));
    const bad = !threw || !dirtyBefore.includes(row.id) || reopened?.data?.name !== 'C4c v2 hors-ligne'
      || cloudName !== 'C4c v2 hors-ligne' || dirtyAfter !== 0
      || opened?.data?.name !== 'C4c v4 portable' || !localKept;
    report('C4c', 'modifs locales non synchronisées ignorées / écrasées à la réouverture', bad, [
      `hors-ligne : saveProject ${threw ? 'lève' : 'RÉSOUT'} ; projets dirty = [${dirtyBefore.join(', ')}]`,
      `réouverture en ligne : "${reopened?.data?.name}" → resynchronisé, cloud="${cloudName}", dirty restants=${dirtyAfter}`,
      `conflit (local v3 non synchronisé, cloud v4 plus récent) : ouvert="${opened?.data?.name}", copie de la version locale conservée : ${localKept ? 'oui' : 'NON'}`,
    ]);
  }

  // ── C6 : renommer ne réécrit pas `data` depuis une copie périmée ──
  {
    fresh();
    const row = await m.createProject('C6', named('C6 v1'));
    await m.getProject(row.id); // copie IDB v1
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(named('C6 v2 portable')));
    __mock.calls = [];
    await m.renameProject(row.id, 'C6 renommé');
    const doc = __mock.col('projects').get(row.id);
    const cloud = await cloudProject(row.id);
    const opened = await m.getProject(row.id);
    const bad = cloud?.name !== 'C6 v2 portable' || doc?.name !== 'C6 renommé' || opened?.name !== 'C6 renommé' || opened?.data?.name !== 'C6 renommé';
    report('C6', 'renameProject réécrit data depuis une copie locale périmée', bad, [
      `après renommage : doc.name="${doc?.name}" ; contenu cloud="${cloud?.name}" (v2 du portable préservée ?)`,
      `réouverture : name="${opened?.name}", data.name="${opened?.data?.name}"`,
    ]);
  }

  // ── C5 : saveProject réécrit folder_id:null / created_at:now dans IDB ──
  {
    fresh();
    const folder = await m.createProjectFolder('Dossier Ultra');
    const row = await m.createProject('C5', named('C5'), folder.id);
    const createdAt = row.created_at;
    await m.saveProject(row.id, named('C5'));
    const idbRow = __idb.projects.get(row.id);
    __mock.dbNetworkDown = true;
    const offlineList = await m.listProjects();
    __mock.dbNetworkDown = false;
    const p = offlineList.find((x: { id: string }) => x.id === row.id);
    report('C5', 'saveProject : ligne IDB avec folder_id=null et created_at=maintenant', idbRow.folder_id === null, [
      `cloud folder_id="${folder.id}", IDB folder_id=${JSON.stringify(idbRow.folder_id)} ; created_at cloud=${createdAt} vs IDB=${idbRow.created_at}`,
      `liste hors-ligne (fallback IDB) : folderId=${JSON.stringify(p?.folderId)} → projet affiché à la racine, date de création fausse`,
      `cloud non affecté (updateDocument n'envoie pas folder_id) → impact limité au mode hors-ligne / fallback`,
    ]);
  }

  // ── R2 : deux sauvegardes concurrentes, la plus ancienne arrive en dernier ──
  {
    fresh();
    const row = await m.createProject('R2', named('R2 v0'));
    __mock.updateLatencyQueue = [800, 50]; // 1re requête lente (gros upload), 2e rapide
    const p1 = m.saveProject(row.id, named('R2 état A (ancien)'));
    await new Promise((r) => setTimeout(r, 100));
    const p2 = m.saveProject(row.id, named('R2 état B (récent)'));
    await Promise.all([p1, p2]);
    const final = await cloudProject(row.id);
    const idbName = __idb.projects.get(row.id)?.data?.name;
    report('R2', 'pas de verrou ni de séquencement des sauvegardes (flushSave / saveProject)', final?.name !== 'R2 état B (récent)', [
      `cloud final = "${final?.name}" ; IndexedDB = "${idbName}"`,
      `→ l'état le plus récent est écrasé dans le cloud par une requête plus ancienne arrivée en retard`,
    ]);
  }

  // ── P1 : listProjects télécharge `data` de chaque projet ──
  {
    fresh();
    for (let i = 0; i < 30; i++) {
      const it = m.createDefaultItinerary(1);
      it.gpxRoute = {
        name: 'r', source: 'gpx',
        points: Array.from({ length: 6000 }, (_, k) => ({ lat: 45 + rnd(), lon: 6 + rnd(), distanceM: k * 50 })),
      };
      await m.createProject(`P${i}`, { ...m.createDefaultProject(), name: `P${i}`, itineraries: [it], activeItineraryId: it.id });
    }
    await m.listProjects();
    const bytes = __mock.lastListResponseBytes;
    const hasSelect = __mock.lastListQueries.some((q: string) => q.includes('"select"'));
    report('P1', 'listProjects sans Query.select : télécharge le champ data de tous les projets', !hasSelect, [
      `requêtes envoyées : ${__mock.lastListQueries.join(' | ')}`,
      `30 projets moyens → réponse ≈ ${(bytes / 1e6).toFixed(1)} Mo pour n'afficher que nom/date/taille (le commentaire projectRows.ts:80 annonce un Query.select absent)`,
    ]);
  }

  // ── P1b : plus de 100 projets → la liste ne doit pas être tronquée ──
  {
    fresh();
    for (let i = 0; i < 130; i++) await m.createProject(`L${i}`, named(`L${i}`));
    const list = await m.listProjects();
    report('P1b', 'listProjects plafonné à 100 projets (pas de pagination)', list.length !== 130, [
      `130 projets en base → ${list.length} listés`,
    ]);
  }

  // ── P2 : deleteProjectFolder sans limit → 25 enfants max détachés ──
  {
    fresh();
    const folder = await m.createProjectFolder('Gros dossier');
    for (let i = 0; i < 30; i++) await m.createProject(`F${i}`, named(`F${i}`), folder.id);
    await m.deleteProjectFolder(folder.id);
    const orphans = [...__mock.col('projects').values()].filter((d: { folder_id: string }) => d.folder_id === folder.id).length;
    const list = await m.listProjects();
    const visibleAtRoot = list.filter((p: { folderId: string | null }) => p.folderId === null).length;
    report('P2', 'deleteProjectFolder : listDocuments sans Query.limit (25 par défaut)', orphans > 0, [
      `30 projets dans le dossier → ${orphans} restent rattachés au dossier supprimé`,
      `visibles à la racine après suppression : ${visibleAtRoot}/30 (useProjectBrowserProjects.ts:500 filtre folderId === currentFolderId → ${orphans} projets introuvables dans l'UI)`,
    ]);
  }

  // ── Hook d'autosave (useDashboardProjectSync) exécuté avec un React minimal ──
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mountSync = (id: string) => {
    const activeProjectSnapshotRef = { current: null as unknown };
    const api = m.useDashboardProjectSync({
      mapInstance: null,
      activeProjectId: id,
      activeProjectIdRef: { current: id },
      activeProjectSnapshotRef,
    });
    return { ...api, activeProjectSnapshotRef };
  };

  // H1 : un seul envoi à la fois, états intermédiaires fusionnés, ordre respecté (A6).
  {
    fresh();
    const row = await m.createProject('H1', named('H1 v0'));
    await m.getProject(row.id);
    const s = mountSync(row.id);
    __mock.calls = [];
    __mock.updateLatencyQueue = [600];
    s.queueProjectSave(named('H1 A'));
    const f1 = s.flushSave();
    await sleep(50);
    s.queueProjectSave(named('H1 B'));
    s.queueProjectSave(named('H1 C'));
    const f2 = s.flushSave();
    await Promise.all([f1, f2]);
    const updates = __mock.calls.filter((c: string) => c === 'updateDocument:projects').length;
    const cloudName = (await cloudProject(row.id))?.name;
    const state = m.getProjectSyncStatus().state;
    report('H1', 'autosave : envois concurrents / désordonnés', cloudName !== 'H1 C' || updates !== 2 || state !== 'saved', [
      `cloud final="${cloudName}" ; updateDocument=${updates} (A puis C, B fusionné) ; statut=${state}`,
    ]);
  }

  // H2 : coupure réseau → pas de faux « enregistré », copie locale en attente, réessai au retour réseau (A2).
  {
    fresh();
    const row = await m.createProject('H2', named('H2 v0'));
    await m.getProject(row.id);
    const s = mountSync(row.id);
    __mock.dbNetworkDown = true;
    s.queueProjectSave(named('H2 hors-ligne'));
    await s.flushSave();
    const offlineState = m.getProjectSyncStatus().state;
    const dirtyOffline = __idb.projects.get(row.id)?.dirty;
    __mock.dbNetworkDown = false;
    (g.dispatchEvent as (ev: { type: string }) => void)({ type: 'online' });
    await sleep(20);
    await s.flushSave();
    const cloudName = (await cloudProject(row.id))?.name;
    const finalState = m.getProjectSyncStatus().state;
    const dirtyAfter = __idb.projects.get(row.id)?.dirty;
    const bad = offlineState !== 'pending-offline' || dirtyOffline !== true || cloudName !== 'H2 hors-ligne' || finalState !== 'saved' || dirtyAfter !== false;
    report('H2', 'autosave hors-ligne marqué « enregistré » sans réessai', bad, [
      `hors-ligne : statut=${offlineState}, copie locale dirty=${dirtyOffline}`,
      `retour réseau (événement online) : cloud="${cloudName}", statut=${finalState}, dirty=${dirtyAfter}`,
    ]);
  }

  // H3 : bouton Enregistrer sur un conflit → erreur remontée, puis écrasement explicite (force).
  {
    fresh();
    const row = await m.createProject('H3', named('H3 v0'));
    await m.getProject(row.id);
    const s = mountSync(row.id);
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(named('H3 portable')), 'H3 portable');
    s.activeProjectSnapshotRef.current = named('H3 bureau');
    let threw: { kind?: string } | null = null;
    try { await s.saveNow(); } catch (e) { threw = e as { kind?: string }; }
    const stateAfter = m.getProjectSyncStatus();
    const cloudAfter = (await cloudProject(row.id))?.name;
    const saved = await s.saveNow({ force: true });
    const cloudForced = (await cloudProject(row.id))?.name;
    const bad = threw?.kind !== 'conflict' || stateAfter.state !== 'error' || cloudAfter !== 'H3 portable' || !saved || cloudForced !== 'H3 bureau';
    report('H3', 'saveNow : conflit non signalé / écrasement silencieux', bad, [
      `saveNow : ${threw ? `lève ${threw.kind}` : 'RÉSOUT'} ; statut=${stateAfter.state} « ${stateAfter.message ?? ''} » ; cloud="${cloudAfter}"`,
      `saveNow({ force }) après confirmation : cloud="${cloudForced}"`,
    ]);
  }

  // L1 : déconnexion avec des modifications non synchronisées (A3).
  {
    fresh();
    const row = await m.createProject('L1', named('L1 v1'));
    await m.getProject(row.id);
    __mock.dbNetworkDown = true;
    try { await m.saveProject(row.id, named('L1 v2 hors-ligne')); } catch { /* attendu */ }
    type Refusal = { name?: string; projects?: Array<{ name: string }> };
    let refused = null as Refusal | null;
    try { await m.signOutAccount(); } catch (e) { refused = e as Refusal; }
    const keptOffline = __idb.projects.get(row.id)?.data?.name === 'L1 v2 hors-ligne' && !!m.readStoredAppwriteSession();
    __mock.dbNetworkDown = false;
    let threwOnline: unknown = null;
    try { await m.signOutAccount(); } catch (e) { threwOnline = e; }
    const cloudName = (await cloudProject(row.id))?.name;
    const purged = __idb.projects.size === 0;
    const bad = refused?.name !== 'UnsyncedProjectsError' || !keptOffline || !!threwOnline || cloudName !== 'L1 v2 hors-ligne' || !purged;
    report('L1', 'déconnexion purge IndexedDB malgré des modifications non synchronisées', bad, [
      `hors-ligne : signOutAccount ${refused ? `refuse (${refused.name} : ${refused.projects?.map((p) => p.name).join(', ')})` : 'PURGE'} ; copie locale + session conservées : ${keptOffline ? 'oui' : 'NON'}`,
      `en ligne : dernière synchro puis déconnexion ${threwOnline ? 'en échec' : 'ok'} ; cloud="${cloudName}" ; IDB purgée : ${purged ? 'oui' : 'non'}`,
    ]);
    loginAs('user-A');
  }

  // ── Couches du projet (lib/project/layers.ts) : document / vue / travail local ──
  const cloudRaw = async (id: string) => {
    const doc = __mock.col('projects').get(id);
    return doc ? await m.decompressProjectPayload(doc.data) : null;
  };
  const cloudView = (projectId: string, userId = 'user-A') => {
    const doc = __mock.col('project_views').get(m.projectViewDocumentId(projectId, userId));
    return doc ? JSON.parse(doc.data) as { updatedAt: string; view: Record<string, any> } : null;  
  };
  const viewport = (zoom: number) => ({ center: [6.8, 45.9] as [number, number], zoom, pitch: 50, bearing: 20 });

  // V1 : un changement de vue seul ne réécrit jamais le projet.
  {
    fresh();
    const row = await m.createProject('V1', named('V1'));
    const opened = (await m.getProject(row.id)).data;
    await m.saveProject(row.id, opened);
    __mock.calls = [];
    const viewChanged = { ...opened, activeMode: 'poi', timelineView: 'timeline', dashboard: { mapViewport: viewport(13) } };
    await m.saveProject(row.id, viewChanged); // document identique : rien à envoyer
    m.queueProjectViewSave(row.id, m.extractProjectView(viewChanged));
    await m.flushProjectViews(row.id);
    const projectCalls = __mock.calls.filter((c: string) => c.endsWith(':projects')).length;
    const view = cloudView(row.id);
    const bad = projectCalls !== 0 || view?.view.activeMode !== 'poi' || view?.view.dashboard?.mapViewport?.zoom !== 13;
    report('V1', 'changement de vue (mode, feuille de route, carte) réécrit le projet', bad, [
      `appels sur « projects » après le changement de vue : ${projectCalls} ; vue cloud : mode=${view?.view.activeMode}, zoom=${view?.view.dashboard?.mapViewport?.zoom}`,
    ]);
  }

  // V2 : la vue suit l'utilisateur d'un appareil à l'autre.
  {
    fresh();
    const row = await m.createProject('V2', named('V2'));
    const opened = (await m.getProject(row.id)).data;
    m.queueProjectViewSave(row.id, m.extractProjectView({ ...opened, activeMode: 'rythme', dashboard: { mapViewport: viewport(11) } }));
    await m.flushProjectViews(row.id);
    __idb.clear(); // autre appareil, même compte
    const onB = (await m.getProject(row.id))?.data;
    const bad = onB?.activeMode !== 'rythme' || onB?.dashboard?.mapViewport?.zoom !== 11;
    report('V2', 'vue (mode, vue carte) perdue en changeant d’appareil', bad, [
      `autre appareil : mode=${onB?.activeMode}, zoom=${onB?.dashboard?.mapViewport?.zoom}`,
    ]);
  }

  // V3 : projet enregistré au format précédent (vue + travail dans `data`) → migration sans perte.
  {
    fresh();
    const it = { ...m.createDefaultItinerary(1), id: 'it-v3', opacity: 40, renderMode: 'slope', pendingFitRecompute: true };
    const legacy = {
      ...named('V3 ancien'),
      itineraries: [it],
      activeItineraryId: 'it-v3',
      activeMode: 'poi',
      timelineView: 'timeline',
      dashboard: { mapViewport: viewport(12), rightPanelWidth: 410 },
    };
    const t0 = '2026-09-01T08:00:00.000Z';
    __mock.col('projects').set('legacy01', {
      $id: 'legacy01', $createdAt: t0, $updatedAt: t0, user_id: 'user-A', folder_id: null,
      name: 'V3 ancien', data: await m.compressProjectPayload(legacy), size_bytes: 0, privacy: 'private',
      // Comme toute ligne qu'Appwrite laisse lire à son propriétaire (access.ts).
      $permissions: ['read("user:user-A")', 'update("user:user-A")', 'delete("user:user-A")'],
    });
    const opened = (await m.getProject('legacy01'))?.data;
    await m.flushProjectViews('legacy01');
    const seeded = cloudView('legacy01');
    await m.saveProject('legacy01', { ...opened, name: 'V3 migré' });
    const stored = await cloudRaw('legacy01');
    const storedJson = JSON.stringify(stored);
    const clean = m.isProjectDocument(stored)
      && !('activeMode' in stored) && !('dashboard' in stored) && !('controlPanel' in stored)
      && !storedJson.includes('"opacity"') && !storedJson.includes('pendingFitRecompute');
    __idb.clear(); // autre appareil
    const onB = (await m.getProject('legacy01'))?.data;
    const bad = opened?.activeMode !== 'poi'
      || opened?.itineraries?.[0]?.pendingFitRecompute !== true
      || seeded?.updatedAt !== t0
      || !clean
      || onB?.name !== 'V3 migré'
      || onB?.activeMode !== 'poi'
      || onB?.itineraries?.[0]?.opacity !== 40
      || onB?.dashboard?.mapViewport?.zoom !== 12
      || onB?.itineraries?.[0]?.pendingFitRecompute !== undefined;
    report('V3', 'ancien format : vue ou contenu perdus à la migration', bad, [
      `ouverture : mode=${opened?.activeMode}, travail repris=${opened?.itineraries?.[0]?.pendingFitRecompute === true ? 'oui' : 'non'} ; vue amorcée (horodatée ${seeded?.updatedAt ?? '—'})`,
      `réenregistré : document v2 sans vue ni travail local = ${clean ? 'oui' : 'NON'}`,
      `autre appareil : nom=${onB?.name}, mode=${onB?.activeMode}, opacité=${onB?.itineraries?.[0]?.opacity}, zoom=${onB?.dashboard?.mapViewport?.zoom}, travail=${onB?.itineraries?.[0]?.pendingFitRecompute ?? 'aucun'}`,
    ]);
  }

  // V4 : le travail en attente reste sur l'appareil, jamais dans le document partagé.
  {
    fresh();
    const row = await m.createProject('V4', named('V4'));
    const it = {
      ...m.createDefaultItinerary(1),
      id: 'it-v4',
      pendingRoutePatch: { start: { lat: 45, lon: 6, kind: 'start' }, end: { lat: 45.1, lon: 6.1, kind: 'end' }, via: [] },
    };
    const project = { ...named('V4'), itineraries: [it], activeItineraryId: 'it-v4' };
    await m.saveProject(row.id, project);
    const cloudHasWork = JSON.stringify(await cloudRaw(row.id)).includes('pendingRoutePatch');
    const localKeeps = !!(await m.getProject(row.id))?.data?.itineraries?.[0]?.pendingRoutePatch;
    __mock.calls = [];
    await m.saveProject(row.id, { ...project, itineraries: [{ ...it, pendingRoutePatch: undefined }] });
    const writes = __mock.calls.filter((c: string) => c === 'updateDocument:projects').length;
    const dirty = __idb.projects.raw(row.id)?.dirty;
    const bad = cloudHasWork || !localKeeps || writes !== 0 || dirty !== false;
    report('V4', 'édition en attente envoyée dans le document partagé', bad, [
      `cloud contient pendingRoutePatch : ${cloudHasWork ? 'OUI' : 'non'} ; copie locale la garde : ${localKeeps ? 'oui' : 'NON'}`,
      `travail seul consommé : updateDocument=${writes}, copie locale dirty=${dirty}`,
    ]);
  }

  // V6 : pendant qu'un autre appareil enregistre le document, changer sa vue ne crée aucun conflit.
  {
    fresh();
    const row = await m.createProject('V6', named('V6 v1'));
    const onB = (await m.getProject(row.id)).data;
    await __mockUpdate(__mock, row.id, await m.compressProjectPayload(named('V6 v2 (A)')), 'V6 v2 (A)');
    m.queueProjectViewSave(row.id, m.extractProjectView({ ...onB, activeMode: 'poi' }));
    let threw: unknown = null;
    try { await m.flushProjectViews(row.id); } catch (e) { threw = e; }
    const projectCalls = __mock.calls.filter((c: string) => c.endsWith(':projects')).length;
    const cloudName = (await cloudRaw(row.id))?.name;
    const bad = !!threw || projectCalls !== 0 || cloudName !== 'V6 v2 (A)' || cloudView(row.id)?.view.activeMode !== 'poi';
    report('V6', 'changement de vue en conflit avec le document d’un autre appareil', bad, [
      `vue enregistrée : ${threw ? 'ERREUR' : 'ok'} ; appels « projects » : ${projectCalls} ; document cloud : « ${cloudName} »`,
    ]);
  }

  // V5 : collection `project_views` pas encore créée → la vue reste locale, rien ne casse.
  {
    fresh();
    __mock.missingCollections.add('project_views');
    const row = await m.createProject('V5', named('V5'));
    const opened = (await m.getProject(row.id)).data;
    m.queueProjectViewSave(row.id, m.extractProjectView({ ...opened, activeMode: 'rythme' }));
    let threw: unknown = null;
    try { await m.flushProjectViews(row.id); } catch (e) { threw = e; }
    const reopened = (await m.getProject(row.id))?.data;
    const bad = !!threw || reopened?.activeMode !== 'rythme';
    report('V5', 'collection project_views absente : erreur ou vue perdue', bad, [
      `flush : ${threw ? 'lève' : 'ok'} ; réouverture (même appareil) : mode=${reopened?.activeMode}`,
    ]);
  }

  // PR1 : profils de tracé perso dans le compte (multi-appareils) et embarqués dans le document.
  {
    fresh();
    const base = m.createDefaultItinerary(1);
    const { applyToAllItineraries: _unused, ...roadTypes } = base.roadTypes;
    const profile = (id: string, name: string) => ({ id, name, basePresetId: 'gravel-default', roadTypes, priorities: { ...base.priorities }, createdAt: 1 });
    const storage = g.localStorage as MemStorage;
    storage.setItem('redview_custom_routing_profiles', JSON.stringify([profile('custom-legacy', 'Ancien')]));
    const migrated = m.getSavedCustomProfiles().map((p: { id: string }) => p.id).join();
    await m.syncCustomProfilesWithAccount();
    const inPrefs = (__mock.user.prefs?.routingProfiles ?? []).map((p: { id: string }) => p.id).join();
    const legacyGone = storage.getItem('redview_custom_routing_profiles') === null;
    // Autre appareil (même compte) : la bibliothèque arrive du compte, puis il supprime le profil.
    const stalePrefsCopy = storage.getItem('redview:routing-profiles:v2');
    storage.clear();
    await m.syncCustomProfilesWithAccount();
    const onB = m.getSavedCustomProfiles().map((p: { id: string }) => p.id).join();
    m.deleteCustomProfileFromStorage('custom-legacy');
    await m.syncCustomProfilesWithAccount();
    // Retour sur le premier appareil, copie locale périmée : le profil ne doit pas revenir.
    storage.setItem('redview:routing-profiles:v2', stalePrefsCopy ?? '');
    await m.syncCustomProfilesWithAccount();
    const backOnA = m.getSavedCustomProfiles().map((p: { id: string }) => p.id).join();
    // Projet utilisant un profil perso : copie embarquée dans le document.
    m.saveCustomProfileToStorage(profile('custom-doc', 'Gravel doux'));
    const row = await m.createProject('PR1', {
      ...named('PR1'),
      itineraries: [{ ...base, id: 'it-pr1', profileId: 'custom-doc' }],
      activeItineraryId: 'it-pr1',
    });
    const embedded = ((await cloudRaw(row.id))?.routingProfiles ?? []).map((p: { name: string }) => p.name).join();
    const bad = migrated !== 'custom-legacy' || inPrefs !== 'custom-legacy' || !legacyGone
      || onB !== 'custom-legacy' || backOnA !== '' || embedded !== 'Gravel doux';
    report('PR1', 'profils de tracé perso : pas synchronisés entre appareils / absents du projet', bad, [
      `ancienne clé reprise : ${migrated || '—'} → préférences du compte : ${inPrefs || '—'} ; ancienne clé supprimée : ${legacyGone ? 'oui' : 'non'}`,
      `autre appareil : ${onB || '—'} ; supprimé là-bas puis copie périmée resynchronisée : « ${backOnA || 'aucun'} »`,
      `document du projet : profils embarqués = ${embedded || '—'}`,
    ]);
  }

  const reproduced = results.filter((r) => r.reproduced);
  console.log(`\n=== ${reproduced.length}/${results.length} scénarios reproduits : ${reproduced.map((r) => r.id).join(', ')} ===`);
  process.exit(reproduced.length ? 1 : 0);
}

/** Écriture directe côté « serveur » (simule un autre appareil). */
async function __mockUpdate(mock: any, id: string, data: string, name = 'C4 v2') {  
  const c = mock.col('projects');
  const cur = c.get(id);
  c.set(id, { ...cur, data, name, $updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
  mock.calls = [];
}

// Une promesse jamais résolue (file d’attente bloquée) viderait la boucle
// d’événements : Node sortirait en 0 sans avoir fini. Échec explicite.
process.on('beforeExit', () => {
  console.error('Simulation interrompue : boucle d’événements vide avant la fin (promesse jamais résolue).');
  process.exit(4);
});

main().catch((e) => {
  console.error(e);
  process.exit(4);
});
