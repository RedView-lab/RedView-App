/**
 * Coolify sur le VPS de prod, piloté par SSH : partagé par scripts/deploy.mjs
 * (déploiement de HEAD) et scripts/rollback.mjs (retour à une image déjà
 * construite). Coolify n'expose pas son API publiquement : on appelle sa
 * fonction `queue_application_deployment` dans son conteneur, comme son
 * interface, et on suit la file `application_deployment_queues`.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VPS_HOST = '141.145.220.99';
const VPS_USER = 'opc';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'oracle_brouter.key');

export const APP = { uuid: 'q7lznj8fhunybhvuvm3jcu0u', label: 'App' };
/**
 * Serveur temps réel de co-édition (server/multiplayer, Dockerfile.multiplayer),
 * service Coolify à part servi sous https://app.redview.tech/multiplayer.
 * Déployé avant l'application : « Partager » n'apparaît que quand il répond.
 */
export const MULTIPLAYER = { uuid: 'krejrvgvs2w5kmfo27rutffz', label: 'Real-time server' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Interpolé dans du PHP et du shell : uniquement un sha git complet. */
export const COMMIT_RE = /^[0-9a-f]{40}$/;

export function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...options }).trim();
}

export function log(msg) {
  console.log(`\x1b[36m[RedView Deploy]\x1b[0m ${msg}`);
}

export function success(msg) {
  console.log(`\x1b[32m[RedView Deploy] ✔ ${msg}\x1b[0m`);
}

export function warn(msg) {
  console.log(`\x1b[33m[RedView Deploy] ⚠ ${msg}\x1b[0m`);
}

export function error(msg) {
  console.error(`\x1b[31m[RedView Deploy] ✖ ${msg}\x1b[0m`);
}

/** Commande SSH de base vers le VPS ; null (et message) sans la clé. */
export function sshBaseCommand() {
  if (!fs.existsSync(SSH_KEY)) {
    error(`SSH key not found at ${SSH_KEY}`);
    return null;
  }
  return `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR ${VPS_USER}@${VPS_HOST}`;
}

/** Commande lancée sur le VPS ; sa sortie standard. */
export function onVps(sshBaseCmd, command) {
  const b64 = Buffer.from(command).toString('base64');
  return run(`${sshBaseCmd} "echo '${b64}' | base64 -d | bash"`);
}

/** Tags (shas) des images Docker gardées pour une application, la plus récente d'abord. */
export function listImageCommits(sshBaseCmd, applicationUuid) {
  const out = onVps(sshBaseCmd, `sudo docker images --format '{{.Tag}}' '${applicationUuid}'`);
  return out.split(/\r?\n/).filter((tag) => COMMIT_RE.test(tag));
}

/** Sha de l'image du conteneur en service (null si aucun conteneur ne tourne). */
export function runningCommit(sshBaseCmd, applicationUuid) {
  const out = onVps(sshBaseCmd, `sudo docker ps --filter 'name=^${applicationUuid}-' --format '{{.Image}}' | head -1`);
  const tag = out.split(':')[1] ?? '';
  return COMMIT_RE.test(tag) ? tag : null;
}

/**
 * Met en file le déploiement Coolify d'une application et le suit ; true s'il
 * se termine. Sans `commit` : HEAD de la branche (build). Avec `rollback` :
 * redémarre l'image déjà construite pour `commit`, sans build — Coolify ne
 * touche pas au commit enregistré de l'application (« HEAD »), le déploiement
 * suivant repart donc de la branche.
 */
export async function deployCoolifyApplication(sshBaseCmd, { uuid: applicationUuid, label }, { commit = null, rollback = false } = {}) {
  if (commit !== null && !COMMIT_RE.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const extraArgs = commit ? `, commit: '${commit}', rollback: ${rollback ? 'true' : 'false'}, force_rebuild: false` : '';
  const phpScript = `<?php
require 'vendor/autoload.php';
$app = require_once 'bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
$kernel->bootstrap();
$application = App\\Models\\Application::where('uuid', '${applicationUuid}')->first();
$deployment_uuid = (string) Illuminate\\Support\\Str::uuid();
$res = queue_application_deployment(application: $application, deployment_uuid: $deployment_uuid${extraArgs});
echo json_encode($res);
`;
  const b64 = Buffer.from(phpScript).toString('base64');

  let deploymentUuid = '';
  try {
    const triggerRes = run(`${sshBaseCmd} "echo '${b64}' | base64 -d | sudo docker exec -i coolify php"`);
    const parsed = JSON.parse(triggerRes);
    // Interpolé ensuite dans du SQL : uniquement un UUID strict.
    deploymentUuid = UUID_RE.test(String(parsed.deployment_uuid ?? '')) ? parsed.deployment_uuid : '';
    if (parsed.status === 'queue_full') {
      warn(`${label}: Coolify deployment queue is full (${parsed.message ?? ''}).`);
      return false;
    }
    success(`${label}: Coolify deployment queued! UUID: ${deploymentUuid}`);
  } catch (err) {
    warn(`${label}: deployment trigger response: ${err.message}.`);
    return false;
  }
  if (!deploymentUuid) {
    warn(`${label}: no deployment UUID returned.`);
    return false;
  }

  log(`${label}: ${rollback ? 'restarting the existing image' : 'building Docker image on VPS & restarting container'}...`);
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
  warn(`${label}: still running after 3 minutes; check Coolify.`);
  return false;
}

/** Attend un 200 de l'app (le conteneur vient de redémarrer : 502 le temps qu'il démarre). */
export async function waitForAppLive(url = 'https://app.redview.tech') {
  let status = '';
  for (let attempt = 0; attempt < 30 && status !== '200'; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      status = String(response.status);
    } catch {
      status = 'error';
    }
  }
  return status;
}

/** Sans le service, l'app répond 200 avec index.html : seul `{"ok":true}` compte. */
export async function multiplayerHealthy(url = 'https://app.redview.tech/multiplayer/health') {
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}
