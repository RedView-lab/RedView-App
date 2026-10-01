/**
 * Audit A — Simulation hors-ligne de la persistance projet (pistes C1, C2, C4, C5, R2, P1, P2).
 *
 * Bundle avec esbuild le VRAI code :
 *   src/shared/utils/projects/{projectRows,folders,compression}.ts + src/shared/services/appwrite.ts
 * en remplaçant uniquement :
 *   - le paquet `appwrite` (SDK web)        → a-mock-appwrite-sdk.ts (data ≤ 16 M car., proxy nginx 502 au-delà, limit 25 par défaut)
 *   - shared/utils/storage/idbProjectStore  → a-mock-idb.ts (IndexedDB en mémoire)
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

async function loadBundle() {
  const esbuild = await import('esbuild');
  const outFile = path.join(os.tmpdir(), `rv-audit-persist-${process.pid}.mjs`);
  const entry = `
    export * from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/projectRows.ts'))};
    export * from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/folders.ts'))};
    export { compressProjectPayload, decompressProjectPayload } from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/compression.ts'))};
    export { readStoredAppwriteSession, saveStoredAppwriteSession, clearStoredAppwriteSession, getAppwriteUser, onAppwriteSessionExpired } from ${JSON.stringify(path.join(SRC, 'shared/services/appwrite.ts'))};
    export { createDefaultProject, createDefaultItinerary } from ${JSON.stringify(path.join(SRC, 'features/itineraryPanel/lib/project/index.ts'))};
    export { useDashboardProjectSync } from ${JSON.stringify(path.join(SRC, 'pages/Dashboard/useDashboardProjectSync.ts'))};
    export { getProjectSyncStatus } from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/syncStatus.ts'))};
    export { __mock } from 'appwrite';
    export { __idb } from '@/shared/utils/storage/idbProjectStore';
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
        build.onResolve({ filter: /^appwrite$/ }, () => ({ path: path.join(import.meta.dirname, 'a-mock-appwrite-sdk.ts') }));
        build.onResolve({ filter: /^react$/ }, () => ({ path: path.join(import.meta.dirname, 'a-mock-react.ts') }));
        build.onResolve({ filter: /idbProjectStore$/ }, () => ({ path: path.join(import.meta.dirname, 'a-mock-idb.ts') }));
        build.onResolve({ filter: /^@\// }, (args) =>
          build.resolve('./' + args.path.slice(2), { resolveDir: SRC, kind: args.kind }));
      },
    }],
  });
  const mod = await import(`file:///${outFile.replace(/\\/g, '/')}`);
  fs.rmSync(outFile, { force: true });
  return mod as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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

  // ── C1e : charge utile compressée > 12 M car. (limite nginx) → refus client explicite ──
  {
    fresh();
    const row = await m.createProject('C1e', named('C1e'));
    // ~15 Mo de texte quasi incompressible (< 16 MiB brut, gz+b64 > 12 M car.)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chunk = Array.from({ length: 1_000_000 }, () => alphabet[Math.floor(rnd() * 62)]).join('');
    const blob = Array.from({ length: 15 }, (_, i) => chunk.slice(i * 997) + chunk.slice(0, i * 997)).join('');
    const huge = { ...named('C1e énorme'), auditBlob: blob };
    const rawBytes = Buffer.byteLength(JSON.stringify(huge));
    __mock.calls = [];
    let threw: { kind?: string; message?: string } | null = null;
    try { await m.saveProject(row.id, huge); } catch (e) { threw = e as { kind?: string; message?: string }; }
    const updates = __mock.calls.filter((c: string) => c === 'updateDocument:projects').length;
    const idbKept = __idb.projects.get(row.id)?.data?.name === 'C1e énorme';
    const bad = threw?.kind !== 'too-large' || updates > 0 || __mock.proxyRejections > 0 || !idbKept;
    report('C1e', 'payload compressé > 12 M car. envoyé quand même (502 nginx, réessais sans fin)', bad, [
      `brut=${(rawBytes / 1e6).toFixed(2)} Mo (< 16 MiB) ; saveProject : ${threw ? `lève ${threw.kind} « ${threw.message?.slice(0, 60)}… »` : 'RÉSOUT'}`,
      `updateDocument tentés : ${updates} ; 502 du proxy : ${__mock.proxyRejections} ; copie IndexedDB conservée : ${idbKept ? 'oui' : 'NON'}`,
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
    const off = m.onAppwriteSessionExpired((d: unknown) => expired.push(d));
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

  const reproduced = results.filter((r) => r.reproduced);
  console.log(`\n=== ${reproduced.length}/${results.length} scénarios reproduits : ${reproduced.map((r) => r.id).join(', ')} ===`);
  process.exit(reproduced.length ? 1 : 0);
}

/** Écriture directe côté « serveur » (simule un autre appareil). */
async function __mockUpdate(mock: any, id: string, data: string, name = 'C4 v2') { // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = mock.col('projects');
  const cur = c.get(id);
  c.set(id, { ...cur, data, name, $updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
  mock.calls = [];
}

main().catch((e) => {
  console.error(e);
  process.exit(4);
});
