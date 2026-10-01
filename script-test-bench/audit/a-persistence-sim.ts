/**
 * Audit A — Simulation hors-ligne de la persistance projet (pistes C1, C2, C4, C5, R2, P1, P2).
 *
 * Bundle avec esbuild le VRAI code :
 *   src/shared/utils/projects/{projectRows,folders,compression}.ts + src/shared/services/appwrite.ts
 * en remplaçant uniquement :
 *   - le paquet `appwrite` (SDK web)        → a-mock-appwrite-sdk.ts (limite data 1 000 000 car., limit 25 par défaut)
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

async function loadBundle() {
  const esbuild = await import('esbuild');
  const outFile = path.join(os.tmpdir(), `rv-audit-persist-${process.pid}.mjs`);
  const entry = `
    export * from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/projectRows.ts'))};
    export * from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/folders.ts'))};
    export { compressProjectPayload, decompressProjectPayload } from ${JSON.stringify(path.join(SRC, 'shared/utils/projects/compression.ts'))};
    export { readStoredAppwriteSession, saveStoredAppwriteSession } from ${JSON.stringify(path.join(SRC, 'shared/services/appwrite.ts'))};
    export { createDefaultProject, createDefaultItinerary } from ${JSON.stringify(path.join(SRC, 'features/itineraryPanel/lib/project/index.ts'))};
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
  {
    fresh();
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
    const big = heavy('Copie de GT20');
    const row = await m.createProject('Copie de GT20', big, null);
    const list = await m.listProjects();
    const visible = list.some((p: { id: string }) => p.id === row.id);
    report('C1b', 'createProject (dupliquer) d\'un gros projet retombe en « local-* » jamais synchronisé', row.id.startsWith('local-') && !visible, [
      `id renvoyé : ${row.id} (aucune erreur, toast « Projet dupliqué » affiché par useProjectBrowserProjects.ts:403)`,
      `listProjects() (cloud OK) contient le projet ? ${visible ? 'oui' : 'NON → disparaît de la liste au prochain refresh'}`,
      `saveProject sur un id local-* ne tente jamais le cloud (projectRows.ts:243) → jamais sauvegardé côté serveur`,
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
      `rename levé ? ${threwRen ? 'oui' : 'non'} ; delete levé ? ${threwDel ? 'oui' : 'non'} (UI : succès, projet retiré de la liste)`,
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

  const reproduced = results.filter((r) => r.reproduced);
  console.log(`\n=== ${reproduced.length}/${results.length} scénarios reproduits : ${reproduced.map((r) => r.id).join(', ')} ===`);
  process.exit(reproduced.length ? 1 : 0);
}

/** Écriture directe côté « serveur » (simule un autre appareil). */
async function __mockUpdate(mock: any, id: string, data: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = mock.col('projects');
  const cur = c.get(id);
  c.set(id, { ...cur, data, name: 'C4 v2', $updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
  mock.calls = [];
}

main().catch((e) => {
  console.error(e);
  process.exit(4);
});
