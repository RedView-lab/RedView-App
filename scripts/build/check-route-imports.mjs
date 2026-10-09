/**
 * Chaque route d'API bundlée se charge sur la plateforme qui l'exécute.
 *
 *   node scripts/build/check-route-imports.mjs [dist-server/api]
 *
 * Lancé dans l'image Docker (étape `runner` du Dockerfile, aarch64 musl en
 * production) et par `server:check` : un module natif sans binaire pour la
 * plateforme ne se voit qu'au chargement de la route, donc à la première
 * requête en production. `@mattnucc/gribberish` n'avait aucun binaire Linux
 * ARM64 : `/api/meteofrance` répondait 500 à toute requête sur le VPS, et le
 * mode neige perdait l'analyse AROME, sans que rien d'autre ne le montre.
 * Autonome (aucun import du dépôt) : l'image n'a que dist-server/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const apiDir = path.resolve(process.argv[2] ?? 'dist-server/api');

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listModules(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

const modules = listModules(apiDir);
if (modules.length === 0) {
  console.error(`[route-imports] aucune route dans ${apiDir}`);
  process.exit(1);
}

const failures = [];
for (const file of modules) {
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') failures.push(`${path.relative(apiDir, file)} : pas de gestionnaire par défaut`);
  } catch (error) {
    failures.push(`${path.relative(apiDir, file)} : ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`[route-imports] ${failures.length} route(s) ne se chargent pas sur ${process.platform}-${process.arch} :`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[route-imports] ${modules.length} routes chargées sur ${process.platform}-${process.arch}`);
// Certaines routes arment des minuteurs au chargement (caches, limiteurs).
process.exit(0);
