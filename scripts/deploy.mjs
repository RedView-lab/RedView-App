/**
 * RedView Production Deployment CLI
 * Usage:
 *   npm run push
 *   npm run push "feat: my change"
 *   node scripts/deploy.mjs "fix(weather): update palette"
 */
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const VPS_HOST = '141.145.220.99';
const VPS_USER = 'opc';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'oracle_brouter.key');
const APP_UUID = 'q7lznj8fhunybhvuvm3jcu0u';

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8', ...options }).trim();
}

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

async function main() {
  const customMessage = process.argv.slice(2).join(' ').trim();
  const commitMessage = customMessage || 'fix: update and deploy to production';

  log('Starting deployment pipeline...');

  // 1. Check git status
  const status = run('git status --porcelain');
  if (status) {
    log(`Staging and committing changes with message: "${commitMessage}"`);
    run('git add .');
    try {
      run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
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

  // 3. Trigger Coolify deployment on Oracle VPS
  log(`Connecting to VPS (${VPS_HOST}) via SSH to trigger Coolify build...`);
  if (!fs.existsSync(SSH_KEY)) {
    error(`SSH key not found at ${SSH_KEY}`);
    process.exit(1);
  }

  const phpScript = `<?php
require 'vendor/autoload.php';
$app = require_once 'bootstrap/app.php';
$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);
$kernel->bootstrap();
$application = App\\Models\\Application::where('uuid', '${APP_UUID}')->first();
$deployment_uuid = (string) Illuminate\\Support\\Str::uuid();
$res = queue_application_deployment(application: $application, deployment_uuid: $deployment_uuid);
echo json_encode($res);
`;
  const b64 = Buffer.from(phpScript).toString('base64');
  const sshBaseCmd = `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST}`;
  
  let deploymentUuid = '';
  try {
    const triggerRes = run(`${sshBaseCmd} "echo '${b64}' | base64 -d | sudo docker exec -i coolify php"`);
    const parsed = JSON.parse(triggerRes);
    deploymentUuid = parsed.deployment_uuid;
    success(`Coolify deployment queued! UUID: ${deploymentUuid}`);
  } catch (err) {
    warn(`Deployment trigger response: ${err.message}. Checking latest deployment in database...`);
  }

  // 4. Poll deployment progress
  log('Building Docker image on VPS & restarting container (typically ~25-35s)...');
  const startTime = Date.now();
  let finished = false;

  for (let attempt = 1; attempt <= 45; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const sql = deploymentUuid
        ? `SELECT status FROM application_deployment_queues WHERE deployment_uuid = '${deploymentUuid}';`
        : `SELECT status FROM application_deployment_queues ORDER BY id DESC LIMIT 1;`;
      const dbStatus = run(`${sshBaseCmd} "echo \\"${sql}\\" | sudo docker exec -i coolify-db psql -U coolify -d coolify -t -A"`).trim();

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\r\x1b[36m[RedView Deploy]\x1b[0m Build status: \x1b[33m${dbStatus}\x1b[0m (${elapsed}s elapsed)... `);

      if (dbStatus === 'finished') {
        finished = true;
        console.log('\n');
        success(`Production deployment completed in ${elapsed}s!`);
        break;
      }
      if (dbStatus === 'failed' || dbStatus === 'cancelled') {
        console.log('\n');
        error(`Deployment ended with status: ${dbStatus}`);
        break;
      }
    } catch {
      // retry
    }
  }

  // 5. Verification
  log('Verifying production endpoint...');
  try {
    const testRes = run('node -e "fetch(\'http://app.141.145.220.99.sslip.io\').then(r => console.log(r.status))"');
    success(`Production is LIVE on http://app.141.145.220.99.sslip.io (HTTP ${testRes})`);
  } catch {
    log('Production URL: http://app.141.145.220.99.sslip.io');
  }
}

main().catch((err) => {
  error(`Deployment error: ${err.message}`);
  process.exit(1);
});
