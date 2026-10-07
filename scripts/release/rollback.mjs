/**
 * Retour arrière de la prod en une commande, sans rebuild : Coolify redémarre
 * l'image Docker déjà construite pour un commit précédent (il en garde
 * plusieurs par application). ~30 s par service au lieu de ~3 min de build.
 *
 *   npm run rollback                    versions disponibles (app + temps réel), celle en service marquée
 *   npm run rollback -- <sha>           app ET serveur temps réel reviennent à <sha> (préfixe accepté)
 *   npm run rollback -- <sha> --app-only
 *
 * Seul le code revient en arrière : schéma Appwrite, données et configuration
 * Coolify ne bougent pas. `main` contient toujours le commit fautif : le
 * prochain `npm run deploy` le redéploierait — le corriger ou le `git revert`
 * avant.
 */
import {
  APP,
  MULTIPLAYER,
  deployCoolifyApplication,
  error,
  listImageCommits,
  log,
  multiplayerHealthy,
  run,
  runningCommit,
  sshBaseCommand,
  success,
  waitForAppLive,
  warn,
} from './lib/coolify.mjs';
import { annotateUmami } from './lib/umamiAnnotation.mjs';

function describeCommit(sha) {
  try {
    return run(`git log -1 --format="%cd  %s" --date=format:"%d/%m %H:%M" ${sha}`);
  } catch {
    return '(commit absent du dépôt local)';
  }
}

function listVersions(sshBaseCmd) {
  for (const service of [APP, MULTIPLAYER]) {
    const current = runningCommit(sshBaseCmd, service.uuid);
    const commits = listImageCommits(sshBaseCmd, service.uuid);
    console.log(`\n${service.label} — images gardées sur le VPS :`);
    for (const sha of commits) {
      const marker = sha === current ? '  ← en service' : '';
      console.log(`  ${sha.slice(0, 12)}  ${describeCommit(sha)}${marker}`);
    }
    if (current && !commits.includes(current)) console.log(`  (en service : ${current.slice(0, 12)}, image non listée)`);
  }
  console.log('\nRetour arrière : npm run rollback -- <sha> [--app-only]');
}

/** Sha complet d'une image gardée commençant par `prefix` ; null si absent ou ambigu. */
function resolveImageCommit(prefix, commits) {
  const matches = commits.filter((sha) => sha.startsWith(prefix.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) error(`« ${prefix} » désigne plusieurs images : ${matches.map((sha) => sha.slice(0, 12)).join(', ')}`);
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const appOnly = args.includes('--app-only');
  const target = args.find((arg) => !arg.startsWith('--'));
  const sshBaseCmd = sshBaseCommand();
  if (!sshBaseCmd) process.exit(1);

  if (!target) {
    listVersions(sshBaseCmd);
    return;
  }
  if (!/^[0-9a-f]{7,40}$/i.test(target)) {
    error(`« ${target} » n'est pas un sha de commit (7 à 40 caractères hexadécimaux).`);
    process.exit(1);
  }

  const appCommit = resolveImageCommit(target, listImageCommits(sshBaseCmd, APP.uuid));
  if (!appCommit) {
    error(`Aucune image de l'app pour ${target} sur le VPS : npm run rollback liste celles qui existent.`);
    process.exit(1);
  }
  const services = [];
  if (!appOnly) {
    // Même ordre que le déploiement : le serveur temps réel d'abord.
    if (listImageCommits(sshBaseCmd, MULTIPLAYER.uuid).includes(appCommit)) services.push(MULTIPLAYER);
    else warn(`Pas d'image du serveur temps réel pour ${appCommit.slice(0, 12)} : il reste sur sa version actuelle.`);
  }
  services.push(APP);

  log(`Retour arrière à ${appCommit.slice(0, 12)} — ${describeCommit(appCommit)}`);
  let ok = true;
  for (const service of services) {
    const before = runningCommit(sshBaseCmd, service.uuid);
    if (before === appCommit) {
      log(`${service.label}: déjà sur ${appCommit.slice(0, 12)}, redémarré quand même depuis son image.`);
    }
    if (!(await deployCoolifyApplication(sshBaseCmd, service, { commit: appCommit, rollback: true }))) {
      ok = false;
      continue;
    }
    const after = runningCommit(sshBaseCmd, service.uuid);
    if (after === appCommit) success(`${service.label}: en service sur ${appCommit.slice(0, 12)} (avant : ${before?.slice(0, 12) ?? 'inconnu'}).`);
    else {
      error(`${service.label}: le conteneur en service est ${after?.slice(0, 12) ?? 'introuvable'}, pas ${appCommit.slice(0, 12)}.`);
      ok = false;
    }
  }

  const appStatus = await waitForAppLive();
  if (appStatus === '200') success('https://app.redview.tech répond 200.');
  else {
    error(`https://app.redview.tech ne répond pas 200 (dernier : ${appStatus}).`);
    ok = false;
  }
  if (await multiplayerHealthy()) success('Serveur temps réel : {"ok":true}.');
  else warn('Serveur temps réel : pas de {"ok":true} (le partage reste masqué tant qu\'il ne répond pas).');

  if (ok) await annotateUmami(`Retour arrière à ${appCommit.slice(0, 12)}`);
  warn('main contient toujours le commit fautif : le prochain `npm run deploy` le redéploierait. Le corriger ou le `git revert` avant.');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  error(`Rollback error: ${err.message}`);
  process.exit(1);
});
