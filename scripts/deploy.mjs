/**
 * RedView Production Deployment CLI
 * Usage:
 *   npm run push
 *   npm run push "feat: my change"
 *   node scripts/deploy.mjs "fix(weather): update palette"
 *   node scripts/deploy.mjs --skip-checks "fix: hotfix"   (urgence : gate qualité sauté)
 *
 * Le gate qualité (scripts/check.mjs --full) tourne d'abord, sur l'arbre qui
 * va être commité : en cas d'échec, rien n'est commité ni poussé.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SKIP_CHECKS_FLAG = '--skip-checks';
const CHECK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check.mjs');

const VPS_HOST = '141.145.220.99';
const VPS_USER = 'opc';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'oracle_brouter.key');
const APP_UUID = 'q7lznj8fhunybhvuvm3jcu0u';
/**
 * Serveur temps réel de co-édition (server/multiplayer, Dockerfile.multiplayer),
 * service Coolify à part servi sous https://app.redview.tech/multiplayer.
 * Déployé avant l'application : « Partager » n'apparaît que quand il répond.
 */
const MULTIPLAYER_APP_UUID = 'krejrvgvs2w5kmfo27rutffz';

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...options }).trim();
}

// Fichiers qui ne doivent JAMAIS partir sur GitHub, même si le .gitignore
// venait à les rater.
const FORBIDDEN_STAGED_RE = /(^|\/)(\.env(\..+)?|COOLIFY\.txt|[^/]+\.(key|pem|p12))$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(msg) {
  console.log(`\x1b[36m[RedView Deploy]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m[RedView Deploy] ✔ ${msg}\x1b[0m`);
}

function warn(msg) {
  console.log(`\x1b[33m[RedView Deploy] ⚠ ${msg}\x1b[0m`);
}

function error(msg) {
  console.error(`\x1b[31m[RedView Deploy] ✖ ${msg}\x1b[0m`);
}

/** Gate qualité complet, sortie affichée en direct. */
function runQualityGate() {
  log('Running quality gate (types, lint, tests, knip, cycles, build, regressions)...');
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, '--full'], { stdio: 'inherit' });
  return result.status === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const skipChecks = args.includes(SKIP_CHECKS_FLAG);
  const customMessage = args.filter((arg) => arg !== SKIP_CHECKS_FLAG).join(' ').trim();
  const baseCommitMessage = customMessage || 'fix: update and deploy to production';
  // Trace dans l'historique d'un déploiement sans gate.
  const commitMessage = skipChecks ? `${baseCommitMessage}\n\nChecks-Skipped: true` : baseCommitMessage;

  log('Starting deployment pipeline...');

  // 0. Quality gate, before anything is committed or pushed
  if (skipChecks) {
    warn('QUALITY GATE SKIPPED (--skip-checks): deploying unverified code.');
  } else if (!runQualityGate()) {
    error('Quality gate failed: nothing was committed or pushed. Fix the errors above, then deploy again.');
    process.exit(1);
  } else {
    success('Quality gate passed.');
  }

  // 1. Check git status
  const status = run('git status --porcelain');
  if (status) {
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
    log('No unstaged changes in working tree.');
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
  if (!fs.existsSync(SSH_KEY)) {
    error(`SSH key not found at ${SSH_KEY}`);
    process.exit(1);
  }
  const sshBaseCmd = `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new ${VPS_USER}@${VPS_HOST}`;

  const multiplayerOk = await deployCoolifyApplication(sshBaseCmd, MULTIPLAYER_APP_UUID, 'Real-time server');
  if (!multiplayerOk) {
    warn('Real-time server not deployed: the app still deploys (sharing stays hidden until /multiplayer/health answers).');
  }
  const appOk = await deployCoolifyApplication(sshBaseCmd, APP_UUID, 'App');
  if (!appOk) process.exitCode = 1;

  // 5. Verification
  log('Verifying production endpoint...');
  // Le conteneur vient de redémarrer : 502 le temps qu'il démarre, on attend un vrai 200.
  let appStatus = '';
  for (let attempt = 0; attempt < 30 && appStatus !== '200'; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      appStatus = run('node -e "fetch(\'https://app.redview.tech\', { cache: \'no-store\' }).then(r => console.log(r.status), () => console.log(\'error\'))"');
    } catch {
      appStatus = 'error';
    }
  }
  if (appStatus === '200') {
    success('Production is LIVE on https://app.redview.tech (HTTP 200)');
    await annotateUmamiDeploy();
  } else {
    error(`Production not answering 200 after 90 s (last: ${appStatus}) — check Coolify.`);
    process.exitCode = 1;
  }
  try {
    // Sans le service, l'app répond 200 avec index.html : seul `{"ok":true}` compte.
    const health = run('node -e "fetch(\'https://app.redview.tech/multiplayer/health\').then(r => r.json()).then(b => console.log(b.ok === true ? \'ok\' : \'ko\'), () => console.log(\'ko\'))"');
    if (health === 'ok') success('Real-time server is LIVE (https://app.redview.tech/multiplayer/health)');
    else warn('Real-time server not answering yet (sharing stays hidden until /multiplayer/health returns {"ok":true}).');
  } catch {
    warn('Real-time server health check failed (sharing stays hidden until it answers).');
  }
}

/**
 * Note « Déploiement <sha> » sur les courbes d'Umami (annotations 3.4) : une
 * variation d'audience, de Web Vitals ou d'un entonnoir se lit face au
 * déploiement qui l'a causée. Best-effort et silencieux sans clé API
 * (~/.redview/umami.json, voir scripts/umami/client.ts).
 */
async function annotateUmamiDeploy() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.redview', 'umami.json'), 'utf8'));
  } catch {
    // Pas de fichier : variables d'environnement seulement.
  }
  const apiKey = process.env.UMAMI_API_KEY || config.apiKey;
  if (!apiKey) return;
  const url = (process.env.UMAMI_URL || config.url || 'https://analytics.redview.tech').replace(/\/$/, '');
  const websiteId = process.env.UMAMI_WEBSITE_ID || config.websiteId || '794b9933-1d87-4e8c-af69-a09982cc2353';
  let sha = 'inconnu';
  try {
    sha = run('git rev-parse --short=12 HEAD');
  } catch {
    // Pas de dépôt git lisible : note sans sha.
  }
  try {
    const response = await fetch(`${url}/api/websites/${websiteId}/annotations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: new Date().toISOString(), note: `Déploiement ${sha}`, allDay: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) success(`Umami: deploy annotation added (${sha}).`);
    else warn(`Umami annotation not added (HTTP ${response.status}).`);
  } catch (err) {
    warn(`Umami annotation not added (${err.message}).`);
  }
}

/** Met en file le déploiement Coolify d'une application et le suit ; true s'il se termine. */
async function deployCoolifyApplication(sshBaseCmd, applicationUuid, label) {
  const phpScript = `<?php
require 'vendor/autoload.php';
$app = require_once 'bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
$kernel->bootstrap();
$application = App\\Models\\Application::where('uuid', '${applicationUuid}')->first();
$deployment_uuid = (string) Illuminate\\Support\\Str::uuid();
$res = queue_application_deployment(application: $application, deployment_uuid: $deployment_uuid);
echo json_encode($res);
`;
  const b64 = Buffer.from(phpScript).toString('base64');

  let deploymentUuid = '';
  try {
    const triggerRes = run(`${sshBaseCmd} "echo '${b64}' | base64 -d | sudo docker exec -i coolify php"`);
    const parsed = JSON.parse(triggerRes);
    // Interpolé ensuite dans du SQL : uniquement un UUID strict.
    deploymentUuid = UUID_RE.test(String(parsed.deployment_uuid ?? '')) ? parsed.deployment_uuid : '';
    success(`${label}: Coolify deployment queued! UUID: ${deploymentUuid}`);
  } catch (err) {
    warn(`${label}: deployment trigger response: ${err.message}.`);
    return false;
  }
  if (!deploymentUuid) {
    warn(`${label}: no deployment UUID returned.`);
    return false;
  }

  log(`${label}: building Docker image on VPS & restarting container...`);
  const startTime = Date.now();
  for (let attempt = 1; attempt <= 90; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const sql = `SELECT status FROM application_deployment_queues WHERE deployment_uuid = '${deploymentUuid}';`;
      const dbStatus = run(`${sshBaseCmd} "echo \\"${sql}\\" | sudo docker exec -i coolify-db psql -U coolify -d coolify -t -A"`).trim();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\r\x1b[36m[RedView Deploy]\x1b[0m ${label} build status: \x1b[33m${dbStatus}\x1b[0m (${elapsed}s elapsed)... `);
      if (dbStatus === 'finished') {
        console.log('\n');
        success(`${label}: deployment completed in ${elapsed}s!`);
        return true;
      }
      if (dbStatus === 'failed' || dbStatus === 'cancelled') {
        console.log('\n');
        error(`${label}: deployment ended with status: ${dbStatus}`);
        return false;
      }
    } catch {
      // retry
    }
  }
  console.log('\n');
  warn(`${label}: still building after 3 minutes; check Coolify.`);
  return false;
}

main().catch((err) => {
  error(`Deployment error: ${err.message}`);
  process.exit(1);
});
