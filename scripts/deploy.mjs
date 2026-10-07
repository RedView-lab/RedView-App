/**
 * RedView Production Deployment CLI
 * Usage:
 *   npm run deploy                                   déploie HEAD (arbre propre exigé)
 *   npm run deploy -- --commit-all "feat: message"   commite TOUT l'arbre puis déploie (ancien comportement)
 *   npm run deploy -- --skip-checks                  urgence : gate qualité et schéma sautés
 *
 * Par défaut seul ce qui est commité part : un arbre modifié arrête tout
 * avant le gate. Plusieurs sessions travaillent dans ce dépôt ; `git add .`
 * embarquait le travail en cours de toutes dans un seul commit sans
 * description (c5824fb : 397 fichiers). Commiter par sujet
 * (`git commit -- <fichiers>`), puis déployer.
 *
 * Le gate qualité (scripts/check.mjs --full) tourne ensuite sur l'arbre — donc
 * exactement sur ce qui part —, puis la vérification du schéma Appwrite de
 * prod : en cas d'échec, rien n'est commité ni poussé.
 *
 * Retour arrière : `npm run rollback` (scripts/rollback.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { annotateUmami } from './lib/umamiAnnotation.mjs';
import {
  APP,
  MULTIPLAYER,
  VPS_HOST,
  deployCoolifyApplication,
  error,
  log,
  multiplayerHealthy,
  run,
  sshBaseCommand,
  success,
  waitForAppLive,
  warn,
} from './lib/coolify.mjs';

const SKIP_CHECKS_FLAG = '--skip-checks';
const COMMIT_ALL_FLAG = '--commit-all';
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = path.join(SCRIPTS_DIR, 'check.mjs');
const SCHEMA_SCRIPT = path.join(SCRIPTS_DIR, 'setup-appwrite-schema.mjs');
const ENV_FILE = path.join(SCRIPTS_DIR, '..', '.env');

// Fichiers qui ne doivent JAMAIS partir sur GitHub, même si le .gitignore
// venait à les rater.
const FORBIDDEN_STAGED_RE = /(^|\/)(\.env(\..+)?|COOLIFY\.txt|[^/]+\.(key|pem|p12))$/i;

/** Gate qualité complet, sortie affichée en direct. */
function runQualityGate() {
  log('Running quality gate (types, lint, tests, knip, cycles, build, regressions)...');
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, '--full'], { stdio: 'inherit' });
  return result.status === 0;
}

/**
 * Schéma Appwrite de prod comparé à scripts/setup-appwrite-schema.mjs, en
 * lecture seule : un code qui suppose une collection absente ne part pas
 * (account_deletions a manqué le 07/10). Corriger avec le même script sans
 * `--check`.
 */
function runProdSchemaCheck() {
  log('Checking the production Appwrite schema (read only)...');
  if (!fs.existsSync(ENV_FILE)) {
    error(`No .env at ${ENV_FILE}: the schema check needs APPWRITE_API_KEY.`);
    return false;
  }
  const result = spawnSync(process.execPath, [`--env-file=${ENV_FILE}`, SCHEMA_SCRIPT, '--check'], { stdio: 'inherit' });
  return result.status === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const skipChecks = args.includes(SKIP_CHECKS_FLAG);
  const commitAll = args.includes(COMMIT_ALL_FLAG);
  const customMessage = args.filter((arg) => arg !== SKIP_CHECKS_FLAG && arg !== COMMIT_ALL_FLAG).join(' ').trim();
  // Trace dans l'historique d'un déploiement sans gate.
  const commitMessage = skipChecks ? `${customMessage}\n\nChecks-Skipped: true` : customMessage;

  log('Starting deployment pipeline...');

  // Pas de trim() en tête : la colonne d'état de la première ligne commence par une espace.
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trimEnd();
  if (status && !commitAll) {
    const lines = status.split(/\r?\n/);
    error(`Uncommitted changes (${lines.length}): only committed work is deployed.\n${lines.slice(0, 20).join('\n')}${lines.length > 20 ? '\n…' : ''}`);
    log('Commit them by topic (git commit -- <files>), or deploy everything with: npm run deploy -- --commit-all "<type(scope): message>"');
    process.exit(1);
  }
  if (commitAll && status && !customMessage) {
    error('--commit-all needs a commit message describing the change: npm run deploy -- --commit-all "<type(scope): message>"');
    process.exit(1);
  }
  if (customMessage && !commitAll) warn('Message ignored: nothing to commit (only --commit-all commits).');

  // 0. Quality gate, before anything is committed or pushed
  if (skipChecks) {
    warn('QUALITY GATE SKIPPED (--skip-checks): deploying unverified code.');
  } else if (!runQualityGate()) {
    error('Quality gate failed: nothing was committed or pushed. Fix the errors above, then deploy again.');
    process.exit(1);
  } else {
    success('Quality gate passed.');
  }
  if (!skipChecks) {
    if (!runProdSchemaCheck()) {
      error('Production schema differs from scripts/setup-appwrite-schema.mjs: nothing was committed or pushed. Apply it (node --env-file=.env scripts/setup-appwrite-schema.mjs --only=<ids>), then deploy again.');
      process.exit(1);
    }
    success('Production schema matches.');
  }

  // 1. --commit-all : tout l'arbre en un commit (l'arbre propre est déjà vérifié sinon).
  if (commitAll && status) {
    log(`Staging and committing changes with message: "${commitMessage}"`);
    run('git add .');
    const staged = run('git diff --cached --name-only').split(/\r?\n/).filter(Boolean);
    const forbidden = staged.filter((file) => FORBIDDEN_STAGED_RE.test(file) && !file.endsWith('.env.example'));
    if (forbidden.length > 0) {
      run('git reset -q');
      error(`Refusing to commit sensitive files: ${forbidden.join(', ')}`);
      process.exit(1);
    }
    try {
      // execFile : le message n'est jamais interprété par un shell.
      execFileSync('git', ['commit', '-m', commitMessage], { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err) {
      warn('No new commit created (working tree clean).');
    }
  } else {
    log(`Deploying ${run('git rev-parse --short=12 HEAD')} (working tree clean).`);
  }

  // 2. Git push
  log('Pushing to GitHub origin/main...');
  try {
    const pushOutput = run('git push origin main');
    if (pushOutput) console.log(pushOutput);
    success('Pushed to origin/main successfully.');
  } catch (err) {
    error(`Failed to push: ${err.message}`);
    process.exit(1);
  }

  // 3. Coolify : serveur temps réel puis application (chacun suivi jusqu'au bout).
  log(`Connecting to VPS (${VPS_HOST}) via SSH to trigger Coolify builds...`);
  const sshBaseCmd = sshBaseCommand();
  if (!sshBaseCmd) process.exit(1);

  const multiplayerOk = await deployCoolifyApplication(sshBaseCmd, MULTIPLAYER);
  if (!multiplayerOk) {
    warn('Real-time server not deployed: the app still deploys (sharing stays hidden until /multiplayer/health answers).');
  }
  const appOk = await deployCoolifyApplication(sshBaseCmd, APP);
  if (!appOk) process.exitCode = 1;

  // 5. Verification
  log('Verifying production endpoint...');
  const appStatus = await waitForAppLive();
  if (appStatus === '200') {
    success('Production is LIVE on https://app.redview.tech (HTTP 200)');
    let sha = 'inconnu';
    try {
      sha = run('git rev-parse --short=12 HEAD');
    } catch {
      // Pas de dépôt git lisible : note sans sha.
    }
    await annotateUmami(`Déploiement ${sha}`);
  } else {
    error(`Production not answering 200 after 90 s (last: ${appStatus}) — check Coolify.`);
    process.exitCode = 1;
  }
  if (await multiplayerHealthy()) success('Real-time server is LIVE (https://app.redview.tech/multiplayer/health)');
  else warn('Real-time server not answering yet (sharing stays hidden until /multiplayer/health returns {"ok":true}).');
}

main().catch((err) => {
  error(`Deployment error: ${err.message}`);
  process.exit(1);
});
