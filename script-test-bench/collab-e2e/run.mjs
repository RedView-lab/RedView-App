// Co-édition dans la vraie application (Edge headless + CDP, compte démo).
// Nécessite `npm run dev` (port 5173) et BRouter joignable par /api/brouter.
//
//  - solo.mjs     : sans session (production actuelle) — routage, annuler /
//                   rétablir sans nouveau routage, réouverture sans recalcul
//                   (estampilles du tracé et de la prédiction) ;
//  - two-tabs.mjs : deux onglets en session sur le serveur temps réel de dev
//                   (`?collab=server`) — synchronisation, vue propre à chacun,
//                   seul l'auteur route (bail), annuler / rétablir par
//                   utilisateur, tracé restauré sans BRouter, rechargement ;
//  - comments-solo.mjs / comments-two-users.mjs : commentaires sur la carte
//                   (mode, bulles, fils, zones, liste ; deux utilisateurs
//                   `?devUser=…` : non lu, mention, droits vérifiés par le serveur).
//                   Le viewer LiDAR a le sien : npm run bench:comments-viewer.
//
//   npm run bench:collab-e2e
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = false;

for (const script of ['solo.mjs', 'two-tabs.mjs', 'comments-solo.mjs', 'comments-two-users.mjs']) {
  const run = spawnSync(process.execPath, [path.join(here, script)], { encoding: 'utf8', timeout: 600_000 });
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`❌ ${script} : sortie illisible\n${run.stdout}\n${run.stderr}`);
    failed = true;
    continue;
  }
  console.log(`\n── ${script}`);
  for (const [label, status] of Object.entries(report.steps)) {
    if (status === 'ok') console.log(`✅ ${label}`);
    else if (status === 'FAILED') console.log(`❌ ${label}`);
  }
  const errors = Array.isArray(report.errors) ? report.errors : Object.values(report.errors ?? {}).flat();
  if (errors.length > 0) console.log(`⚠️ erreurs console : ${errors.join(' | ')}`);
  if (report.fatal) console.log(`❌ ${report.fatal}`);
  if (run.status !== 0 || report.failures?.length || report.fatal || errors.length > 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
