/**
 * RedView Test-Bench : parcours de paiement de bout en bout, dans un vrai
 * navigateur, sur le build de production, contre le BAC À SABLE Stripe.
 *
 * Vrai serveur bundlé (`dist-server/server.mjs`, CSP de prod) construit dans un
 * dossier à part (script-test-bench/reports/billing-e2e/build/ : le dist/ du
 * dépôt n'est pas touché), Edge / Chromium sans interface, Payment Element et
 * 3-D Secure réels de Stripe (clés `sk_test_` / `pk_test_` / `whsec_` du .env,
 * refusées si ce ne sont pas des clés de test). Appwrite est simulé des deux
 * côtés : dans le navigateur (dashboard-perf/fakeAppwrite.mjs) et pour le
 * serveur (fakeAppwriteServer.mjs, `APPWRITE_ENDPOINT` pointé dessus) — aucune
 * autre variable du .env n'est transmise au serveur (ni Appwrite de prod, ni
 * Resend : aucun e-mail ne part).
 *
 *   1. onglet Abonnement : trois formules, remises, essai de 7 jours ;
 *   2. « Choisir » 6 mois → Payment Element (4242…), case de consentement,
 *      « Démarrer l’essai gratuit · puis 70 € tous les 6 mois » → toast, statut
 *      d'essai jusqu'à J+7, carte « Essai en cours / Formule actuelle », VISA 4242
 *      par défaut ;
 *   3. webhook : les vrais évènements Stripe du client, signés, envoyés au
 *      serveur bundlé (200, toujours un seul abonnement) ;
 *   4. « Résilier votre contrat » → récapitulatif (compte, formule, sub_…, date)
 *      → « Confirmer la résiliation » → statut « Résilié… », puis reprise ;
 *   5. « Factures et reçus » → billing.stripe.com, retour ;
 *   6. second compte, carte 3-D Secure 4000 0027 6000 3184 : défi Stripe
 *      refusé → message d'erreur, aucun abonnement créé.
 *
 * Contrôles globaux : aucune erreur de page, aucune erreur console inattendue,
 * aucune violation CSP (rapports et console), aucun appel Appwrite non simulé
 * (navigateur et serveur), aucun défaut axe (WCAG A/AA) sur l'onglet
 * Abonnement, la page de paiement et la pop-in de résiliation.
 * Nettoyage : clients Stripe créés supprimés, même en cas d'échec.
 *
 * `--live` ajoute les webhooks réels (`stripe listen`), les e-mails réels vers
 * la boîte factice de Resend et une horloge de test Stripe (fin d'essai, passage
 * en payant, rappel de reconduction) : voir README.md.
 *
 * Usage :
 *   npx tsx script-test-bench/billing-e2e/run.mjs [--live] [--skip-build] [--channel msedge|chromium] [--headed] [--keep]
 * Rapport et captures : script-test-bench/reports/billing-e2e/.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import Stripe from 'stripe';

import { installBackend } from '../dashboard-perf/harness.mjs';
import { auditScreen } from '../user-journey/a11y.ts';
import { startFakeAppwriteServer } from './fakeAppwriteServer.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIR = path.join(REPO, 'script-test-bench', 'reports', 'billing-e2e');
const BUILD_ROOT = path.join(REPORT_DIR, 'build');
const argv = process.argv.slice(2);
const CHANNEL = argv.includes('--channel') ? argv[argv.indexOf('--channel') + 1] : process.env.CI ? 'chromium' : 'msedge';
const HEADED = argv.includes('--headed');
const SKIP_BUILD = argv.includes('--skip-build');
const KEEP = argv.includes('--keep');
/**
 * `--live` : webhooks réels (`stripe listen` relaie le bac à sable vers le
 * serveur bundlé), e-mails réels via Resend vers la boîte factice
 * delivered@resend.dev, et horloge de test Stripe pour la fin d'essai, le
 * passage en payant et le rappel de reconduction.
 */
const LIVE = argv.includes('--live');

// Identifiants neufs à chaque exécution : la clé d'idempotence de création du
// client Stripe (redview-customer-<compte>-none) rendrait sinon, pendant 24 h,
// le client supprimé par le nettoyage de l'exécution précédente.
const RUN_ID = Date.now().toString(36);
// Boîte factice de Resend, prévue pour les tests (accepte et jette).
const ALICE = { $id: `billinge2ealice${RUN_ID}`, email: LIVE ? 'delivered@resend.dev' : 'bench@redview.test', name: 'Banc RedView' };
const CAROL = { $id: `billinge2ecarol${RUN_ID}`, email: 'carol@redview.test', name: 'Carol 3DS' };
const JWT = { alice: 'fake-jwt', carol: 'fake-jwt-carol' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
class CheckError extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckError(message);
}
/** Espaces fines / insécables d'`Intl` ramenées à une espace simple. */
const plain = (text) => String(text).replace(/\s+/g, ' ').trim();

// ── Clés Stripe : seulement celles du bac à sable ─────────────────────────────

function readDotEnv() {
  const env = {};
  const file = path.join(REPO, '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const dotEnv = readDotEnv();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || dotEnv.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || dotEnv.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PUBLISHABLE_KEY = dotEnv.VITE_STRIPE_PUBLISHABLE_KEY || '';
if (!STRIPE_SECRET_KEY.startsWith('sk_test_') || !STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_') || !STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
  console.error('billing-e2e : il faut les clés du BAC À SABLE dans .env (sk_test_, pk_test_ via VITE_STRIPE_PUBLISHABLE_KEY, whsec_).');
  process.exit(2);
}
const stripe = new Stripe(STRIPE_SECRET_KEY);

// ── Build à part ─────────────────────────────────────────────────────────────

function run(command, args, label) {
  // Le shell seulement pour `npx` sous Windows (npx.cmd) : `node.exe` est
  // souvent sous « C:\Program Files », que cmd couperait à l'espace.
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: command === 'npx' && process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-6000));
    throw new Error(`${label} a échoué (${result.status})`);
  }
}

function buildApp() {
  fs.rmSync(BUILD_ROOT, { recursive: true, force: true });
  fs.mkdirSync(BUILD_ROOT, { recursive: true });
  console.log('… vite build (dossier à part)');
  run('npx', ['vite', 'build', '--outDir', path.join(BUILD_ROOT, 'dist'), '--emptyOutDir'], 'vite build');
  run(process.execPath, ['scripts/build/precompress-dist.mjs', path.join(BUILD_ROOT, 'dist')], 'precompress-dist');
  // build-server écrit dans dist-server/ du dépôt (régénéré depuis les mêmes
  // sources par chaque build) ; copié aussitôt à côté du dist/ à part.
  console.log('… build du serveur');
  run(process.execPath, ['scripts/build/build-server.mjs', '--app'], 'build-server');
  fs.cpSync(path.join(REPO, 'dist-server'), path.join(BUILD_ROOT, 'dist-server'), { recursive: true });
}

/** La clé publiable du bac à sable est bien dans le bundle (sinon pas de Payment Element). */
function checkPublishableKeyInBuild() {
  const assets = path.join(BUILD_ROOT, 'dist', 'assets');
  const found = fs.readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .some((name) => fs.readFileSync(path.join(assets, name), 'utf8').includes(STRIPE_PUBLISHABLE_KEY));
  check(found, 'VITE_STRIPE_PUBLISHABLE_KEY absente du build');
}

// ── CLI Stripe (--live) ──────────────────────────────────────────────────────

/** stripe.exe lui-même (pas le stripe.cmd de npm) : un processus à tuer, un seul PID. */
function stripeBinary() {
  if (process.env.STRIPE_CLI) return process.env.STRIPE_CLI;
  if (process.platform !== 'win32') return 'stripe';
  const where = spawnSync('where', ['stripe.cmd'], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0]?.trim();
  const exe = where && path.join(path.dirname(where), 'node_modules', '@stripe', 'cli', 'node_modules', '@stripe', 'cli-win32-x64', 'bin', 'stripe.exe');
  if (!exe || !fs.existsSync(exe)) throw new Error('CLI Stripe introuvable (npm i -g @stripe/cli, ou STRIPE_CLI=<chemin de stripe.exe>)');
  return exe;
}

/** Secret de signature des évènements relayés par `stripe listen` (stable par compte et machine). */
function stripeListenSecret(binary) {
  const result = spawnSync(binary, ['listen', '--api-key', STRIPE_SECRET_KEY, '--print-secret'], { encoding: 'utf8', timeout: 60_000 });
  const secret = result.stdout?.trim();
  check(secret?.startsWith('whsec_'), `stripe listen --print-secret : ${result.stderr?.slice(0, 300) || 'pas de secret'}`);
  return secret;
}

/**
 * `stripe listen` relaie les évènements du bac à sable vers le serveur bundlé.
 * Chaque relais est noté : type et statut HTTP de notre réponse, par évènement.
 */
async function startStripeListen(binary, forwardTo, events) {
  const child = spawn(binary, ['listen', '--api-key', STRIPE_SECRET_KEY, '--forward-to', forwardTo, '--events', events.join(',')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** @type {Map<string, { type: string, status: number | null }>} */
  const deliveries = new Map();
  let output = '';
  let ready = false;
  const onData = (chunk) => {
    output = (output + chunk).slice(-200_000);
    for (const line of String(chunk).split(/\r?\n/)) {
      if (/Ready!/.test(line)) ready = true;
      const sent = /-->\s+([a-z_.]+)\s+\[(evt_[A-Za-z0-9]+)\]/.exec(line);
      if (sent) deliveries.set(sent[2], { type: sent[1], status: deliveries.get(sent[2])?.status ?? null });
      const answered = /<--\s+\[(\d{3})\]\s+\S+\s+\S+\s+\[(evt_[A-Za-z0-9]+)\]/.exec(line);
      if (answered) {
        const previous = deliveries.get(answered[2]);
        deliveries.set(answered[2], { type: previous?.type ?? '?', status: Number(answered[1]) });
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const deadline = Date.now() + 60_000;
  while (!ready) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`stripe listen ne démarre pas\n${output.slice(-2000)}`);
    await sleep(250);
  }
  return {
    deliveries,
    output: () => output,
    /** Attend un évènement relayé de ce type (et la réponse du serveur), après `since` relais déjà vus. */
    async waitFor(type, { timeoutMs = 120_000, after = new Set() } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        for (const [id, delivery] of deliveries) {
          if (delivery.type === type && delivery.status !== null && !after.has(id)) return { id, ...delivery };
        }
        if (Date.now() > end) return null;
        await sleep(500);
      }
    },
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    }),
  };
}

/**
 * Attend la ligne « [TAG] ✅ Email sent via Resend » du mailer dans le journal
 * du serveur ; échoue avec les dernières lignes utiles sinon.
 */
async function expectEmail(server, tag, label) {
  const sent = await server.waitForLog(new RegExp(`\\[${tag}\\] ✅ Email sent via Resend`), 90_000);
  if (sent) return;
  const tail = server.log().split(/\r?\n/).filter((line) => line.includes(tag) || line.includes('stripe/webhook')).slice(-6);
  throw new CheckError(`${label} non envoyé ; journal : ${tail.join(' | ') || '(rien)'}`);
}

/** Avance l'horloge de test et attend que Stripe ait tout traité (statut `ready`). */
async function advanceClock(clockId, frozenTime) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: Math.floor(frozenTime) });
  const end = Date.now() + 180_000;
  for (;;) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') return;
    check(clock.status !== 'internal_failure', `horloge de test en échec (${clock.status})`);
    check(Date.now() < end, `horloge de test toujours « ${clock.status} » après 3 min`);
    await sleep(2000);
  }
}

/** Serveur bundlé : seulement les variables utiles, Appwrite pointé sur le faux serveur. */
async function startAppServer(appwriteEndpoint, { port, webhookSecret, resend }) {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APPWRITE_|VITE_|STRIPE_|RESEND_|SENTRY_|METEOFRANCE_|MULTIPLAYER_|BROUTER_|POI_|WEATHER_|OPENMETEO_)/.test(key)),
  );
  const child = spawn(process.execPath, ['dist-server/server.mjs'], {
    cwd: BUILD_ROOT,
    env: {
      ...baseEnv,
      PORT: String(port),
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      // Retours de Stripe (3-D Secure, portail) vers ce serveur local, jamais
      // vers l'app de production (getAppBaseUrl en production).
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      // Jamais de garde des buckets contre le faux Appwrite (off par défaut, explicite ici).
      REDVIEW_STORAGE_GUARD: 'off',
      APPWRITE_ENDPOINT: appwriteEndpoint,
      APPWRITE_PROJECT_ID: 'billing-e2e',
      APPWRITE_API_KEY: 'billing-e2e-fake-key',
      APPWRITE_DATABASE_ID: 'billing-e2e',
      STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      // E-mails seulement en --live (boîte factice de Resend) ; sinon aucun envoi.
      ...(resend ? { RESEND_API_KEY: resend.apiKey, RESEND_FROM: resend.from } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const keep = (chunk) => {
    output = (output + chunk).slice(-500_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await fetch(`${origin}/health`).then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server.mjs ne démarre pas\n${output}`);
    await sleep(200);
  }
  return {
    origin,
    log: () => output,
    /** Attend une ligne du journal du serveur (e-mail envoyé…). */
    async waitForLog(pattern, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const line = output.split(/\r?\n/).find((entry) => pattern.test(entry));
        if (line) return line;
        if (Date.now() > end) return null;
        await sleep(500);
      }
    },
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    }),
  };
}

// ── Navigateur ───────────────────────────────────────────────────────────────

async function launch(profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    channel: CHANNEL === 'chromium' ? undefined : CHANNEL,
    headless: !HEADED,
    viewport: { width: 1600, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    args: ['--enable-unsafe-swiftshader'],
  });
}

async function stubVpsServices(context, origin) {
  const unavailable = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service coupé (e2e)' }) };
  for (const route of ['brouter', 'poi', 'openmeteo', 'weather', 'meteofrance', 'overpass', 'geocode-iconic', 'snow-context']) {
    await context.route(new RegExp(`^${origin}/api/${route}(?:[/?]|$)`), (request) => request.fulfill(unavailable));
  }
}

/** Contexte connecté sur le compte `user`, facturation servie par le vrai serveur. */
async function openAccount(profileDir, origin, user, jwt) {
  const context = await launch(profileDir);
  const backend = await installBackend(context, { root: REPO, origin, loggedIn: true });
  // installBackend simule /api/billing/** : ici, c'est le vrai serveur qui répond.
  await context.unroute(`${origin}/api/billing/**`);
  Object.assign(backend.appwrite.state.user, { $id: user.$id, email: user.email, name: user.name });
  // Jeton propre au compte : le faux Appwrite serveur en déduit l'utilisateur.
  await context.route(/\/v1\/account\/jwts$/, (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': route.request().headers().origin ?? '*', 'access-control-allow-credentials': 'true' },
    body: JSON.stringify({ jwt }),
  }));
  await stubVpsServices(context, origin);
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page, ...backend };
}

const pageErrors = [];
const consoleErrors = [];
const cspConsole = [];
/** Violations des CSP des pages de Stripe elles-mêmes (pas la nôtre) : rapportées, jamais bloquantes. */
const cspThirdParty = [];
function pageWatch(page, label) {
  page.on('pageerror', (error) => pageErrors.push(`[${label}] ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    const from = message.location()?.url ?? '';
    // Seule notre CSP compte : les pages de Stripe (défi 3DS de test…) ont la leur.
    const fromStripe = /^https:\/\/[^/]*stripe\.(com|network)\//.test(from);
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) {
      if (fromStripe) cspThirdParty.push(`[${label}] ${from.slice(0, 80)} : ${text.slice(0, 200)}`);
      else cspConsole.push(`[${label}] ${text.slice(0, 300)}`);
    } else if (message.type() === 'error' && !text.startsWith('Failed to load resource')) consoleErrors.push(`[${label}] ${text.slice(0, 400)}`);
  });
}

const a11yFindings = [];
async function auditA11y(page, screen) {
  const findings = await auditScreen(page, screen);
  a11yFindings.push(...findings);
  return findings.length;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(REPORT_DIR, `${name}.png`), fullPage: false }).catch(() => undefined);
}

async function step(name, page, body) {
  const startedAt = performance.now();
  try {
    const detail = (await body()) ?? undefined;
    const seconds = (performance.now() - startedAt) / 1000;
    results.push({ step: name, ok: true, seconds, detail });
    console.log(`✔ ${name}${detail ? ` — ${detail}` : ''} (${seconds.toFixed(1)} s)`);
  } catch (error) {
    const seconds = (performance.now() - startedAt) / 1000;
    results.push({ step: name, ok: false, seconds, detail: String(error?.message ?? error) });
    console.log(`✖ ${name} : ${error?.message ?? error}`);
    if (page) {
      const alerts = await page.locator('[role="alert"], [data-sonner-toast]').allInnerTexts().catch(() => []);
      if (alerts.length) console.log(`  alertes / toasts affichés : ${alerts.map(plain).join(' | ')}`);
    }
    if (page) await shot(page,`echec-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    throw error;
  }
}

const longDate = (date) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(date);

/** Formule affichée par sa carte (aria-label « Formule 6 mois : 70,00 € »…). */
const planCard = (page, duration) => page.locator(`[aria-label^="Formule ${duration} :"]`);

/** Premier clic sur « Démarrer l’essai » perdu juste après la saisie de la carte (cf. le parcours). */
let firstClickLost = false;
/** Évènements souris / focus vus par la page pendant ce premier clic (diagnostic). */
let clickProbe = [];
/** Même chose pour la case, après un clic hors de l’iframe (second compte). */
let checkboxClickLostAfterOutsideClick = false;

/** Onglet que le Payment Element ouvre de lui-même (relevé au premier remplissage). */
let openedTab = '';

/** Remplit le Payment Element (iframe Stripe) avec une carte de test. */
async function fillCard(page, number) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    for (const candidate of page.frames()) {
      if (!/js\.stripe\.com/.test(candidate.url())) continue;
      // Moyens de paiement dynamiques : la carte n'est pas forcément l'onglet
      // ouvert (le bac à sable a ouvert BLIK) — on la choisit explicitement.
      const cardTab = candidate.getByRole('tab', { name: /Carte/ }).or(candidate.getByRole('button', { name: /Carte bancaire/ })).first();
      if (await cardTab.count().catch(() => 0)) {
        if (!openedTab) openedTab = (await candidate.getByRole('tab', { selected: true }).first().innerText().catch(() => '?')).trim();
        if ((await cardTab.getAttribute('aria-selected').catch(() => null)) !== 'true') await cardTab.click().catch(() => undefined);
      }
      const input = candidate.locator('input[name="number"]');
      if (await input.count().catch(() => 0)) {
        // Le Payment Element se réorganise pendant la saisie (le champ Pays
        // apparaît une fois le numéro reconnu) et peut vider un champ : chaque
        // valeur est relue, la saisie reprise au besoin.
        const fields = [['number', number], ['expiry', '12 / 34'], ['cvc', '123']];
        for (let attempt = 0; attempt < 4; attempt++) {
          for (const [name, value] of fields) {
            const field = candidate.locator(`input[name="${name}"]`);
            if (!(await field.inputValue().catch(() => ''))) await field.fill(value);
            await sleep(300);
          }
          await sleep(800);
          const values = await Promise.all(fields.map(([name]) => candidate.locator(`input[name="${name}"]`).inputValue().catch(() => '')));
          if (values.every(Boolean)) return;
        }
        throw new CheckError('Payment Element : la saisie de la carte ne tient pas (champ vidé)');
      }
    }
    check(Date.now() < deadline, 'Payment Element : champ du numéro de carte introuvable (iframe Stripe non chargée ?)');
    await sleep(500);
  }
}

/** Évènements Stripe du client depuis `since` (secondes), attendus par type. */
async function customerEvents(customerId, since, required) {
  let events = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    events = [];
    for await (const event of stripe.events.list({ created: { gte: since }, limit: 100 })) {
      const customer = event.data.object?.customer;
      if ((typeof customer === 'string' ? customer : customer?.id) === customerId) events.push(event);
    }
    if (required.every((type) => events.some((event) => event.type === type))) break;
    await sleep(1500);
  }
  return events.sort((a, b) => a.created - b.created);
}

// ── Parcours ─────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  // Captures de l'exécution précédente (échecs compris) : jamais mêlées à celles-ci.
  for (const name of fs.readdirSync(REPORT_DIR)) if (name.endsWith('.png')) fs.rmSync(path.join(REPORT_DIR, name));
  if (!SKIP_BUILD || !fs.existsSync(path.join(BUILD_ROOT, 'dist-server', 'server.mjs'))) buildApp();
  checkPublishableKeyInBuild();

  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const appwriteServer = await startFakeAppwriteServer({ users: { [JWT.alice]: ALICE, [JWT.carol]: CAROL } });
  const port = 3900 + Math.floor(Math.random() * 90);
  let webhookSecret = STRIPE_WEBHOOK_SECRET;
  let listen = null;
  let resend = null;
  if (LIVE) {
    const binary = stripeBinary();
    webhookSecret = stripeListenSecret(binary);
    check(dotEnv.RESEND_API_KEY, '--live : RESEND_API_KEY absente du .env');
    resend = { apiKey: dotEnv.RESEND_API_KEY, from: dotEnv.RESEND_FROM || 'RedView <noreply@redview.tech>' };
    const { WEBHOOK_EVENTS } = await import('../../api/_lib/billing/webhookEvents.ts');
    listen = await startStripeListen(binary, `http://127.0.0.1:${port}/api/stripe/webhook`, [...WEBHOOK_EVENTS]);
  }
  const server = await startAppServer(appwriteServer.endpoint, { port, webhookSecret, resend });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-billing-e2e-'));
  const contexts = [];
  const browserBackends = [];
  let failed = false;
  let page = null;
  /** Horloge de test (--live) : son client est celui du premier compte ; la supprimer supprime le client. */
  let testClock = null;
  const live = { trialWillEnd: null, renewal: null };

  try {
    if (LIVE) {
      testClock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `billing-e2e ${RUN_ID}` });
      const customer = await stripe.customers.create({
        email: ALICE.email,
        preferred_locales: ['fr'],
        metadata: { appwrite_user_id: ALICE.$id },
        test_clock: testClock.id,
      });
      // Le serveur réutilise le client de la ligne `customers` (getOrCreateStripeCustomer).
      appwriteServer.putDocument('customers', ALICE.$id, { user_id: ALICE.$id, stripe_customer_id: customer.id });
    }

    const alice = await openAccount(path.join(workDir, 'alice'), server.origin, ALICE, JWT.alice);
    contexts.push(alice.context);
    browserBackends.push(alice);
    page = alice.page;
    pageWatch(page, 'alice');
    const p = page;

    await step('onglet Abonnement : trois formules et essai', p, async () => {
      await p.goto(`${server.origin}/?tab=subscription`);
      await p.getByRole('heading', { name: 'Abonnement RedView' }).waitFor({ timeout: 60_000 });
      await planCard(p, '1 mois').getByRole('button', { name: 'Choisir' }).waitFor({ timeout: 30_000 });
      const cards = {};
      for (const duration of ['1 mois', '6 mois', '1 an']) cards[duration] = plain(await planCard(p, duration).innerText());
      check(/14,90/.test(cards['1 mois']), `carte 1 mois : ${cards['1 mois']}`);
      check(/70/.test(cards['6 mois']) && /-22\s?%/.test(cards['6 mois']) && /11,67 € par mois/i.test(cards['6 mois']), `carte 6 mois : ${cards['6 mois']}`);
      check(/119/.test(cards['1 an']) && /-33\s?%/.test(cards['1 an']) && /9,92 € par mois/i.test(cards['1 an']), `carte 1 an : ${cards['1 an']}`);
      for (const [duration, text] of Object.entries(cards)) check(text.toLowerCase().includes('7 jours d’essai gratuit inclus'), `pastille d'essai absente sur ${duration}`);
      await shot(p, '01-abonnement');
      const defects = await auditA11y(p, 'abonnement');
      return `${defects} défaut(s) axe`;
    });

    await step('essai 6 mois : Payment Element, consentement, activation', p, async () => {
      await planCard(p, '6 mois').getByRole('button', { name: 'Choisir' }).click();
      const submit = p.getByRole('button', { name: /^Démarrer l’essai gratuit · puis 70/ });
      await submit.waitFor({ timeout: 30_000 });
      check(plain(await submit.innerText()) === 'Démarrer l’essai gratuit · puis 70,00 € tous les 6 mois'
        || /puis 70(,00)? € tous les 6 mois$/.test(plain(await submit.innerText())), `libellé du bouton : ${await submit.innerText()}`);
      await fillCard(p, '4242 4242 4242 4242');
      await shot(p, '02-paiement');
      const defects = await auditA11y(p, 'paiement');
      // Sans la case : refus explicite, rien n'est envoyé à Stripe. Juste après
      // la saisie (focus dans l'iframe Stripe), Chromium sans interface perd le
      // premier clic sur le bouton ; relevé dans le rapport, puis second clic.
      const consentError = p.getByText('Cochez la case pour confirmer votre abonnement.');
      await p.evaluate(() => {
        const seen = [];
        window.__rvClickProbe = seen;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'blur']) {
          window.addEventListener(type, (event) => seen.push(`${type}:${event.target?.tagName ?? 'window'}${event.target?.className ? '.' + String(event.target.className).split(' ')[0] : ''}@${Math.round(performance.now())}`), true);
        }
      });
      await submit.click();
      clickProbe = await p.evaluate(() => window.__rvClickProbe.slice());
      firstClickLost = !(await consentError.waitFor({ timeout: 2_000 }).then(() => true, () => false));
      if (firstClickLost) await submit.click();
      await consentError.waitFor({ timeout: 10_000 });
      await p.getByRole('checkbox').check();
      await submit.click();
      await consentError.waitFor({ state: 'detached', timeout: 10_000 });
      const outcome = p.getByText('Votre essai gratuit a commencé')
        .or(p.locator('[data-sonner-toast][data-type="error"], .rvpb-billing-page__error[role="alert"]')).first();
      await outcome.waitFor({ timeout: 60_000 });
      const outcomeText = plain(await outcome.innerText());
      check(outcomeText.includes('Votre essai gratuit a commencé'), `l’essai n’a pas démarré : « ${outcomeText} »`);
      return `${defects} défaut(s) axe sur la page de paiement ; onglet ouvert d’office : « ${openedTab} »${firstClickLost ? ' ; 1er clic perdu après la saisie' : ''}`;
    });

    let subscriptionId = '';
    const aliceCustomer = () => appwriteServer.customerIdFor(ALICE.$id);

    await step('statut d’essai, carte 6 mois, VISA 4242 par défaut', p, async () => {
      const expected = [longDate(new Date(Date.now() + 7 * 86_400_000)), longDate(new Date(Date.now() + 7 * 86_400_000 - 3_600_000))];
      const status = p.locator('.rvpb-subscription-status');
      await status.waitFor({ timeout: 30_000 });
      const statusText = plain(await status.innerText());
      check(/Essai gratuit jusqu’au /.test(statusText) && expected.some((date) => statusText.includes(date)), `statut : ${statusText} (attendu ${expected[0]})`);
      const card = plain(await planCard(p, '6 mois').innerText());
      check(/essai en cours/i.test(card) && /formule actuelle/i.test(card), `carte 6 mois : ${card}`);
      check(await planCard(p, '6 mois').getByRole('button', { name: 'Formule actuelle' }).isDisabled(), '« Formule actuelle » devrait être désactivé');
      const payment = plain(await p.locator('.rvpb-payment-card.is-default').innerText());
      check(/VISA se terminant par 4242/i.test(payment) && /par défaut/i.test(payment), `moyen de paiement : ${payment}`);
      const customerId = aliceCustomer();
      check(customerId, 'aucun client Stripe enregistré pour le compte');
      const subscriptions = (await stripe.subscriptions.list({ customer: customerId, status: 'all' })).data;
      check(subscriptions.length === 1 && subscriptions[0].status === 'trialing', `abonnements Stripe : ${subscriptions.map((s) => s.status).join(', ')}`);
      subscriptionId = subscriptions[0].id;
      check(subscriptions[0].items.data[0].price.lookup_key === 'redview_semiannual', `prix : ${subscriptions[0].items.data[0].price.lookup_key}`);
      await shot(p, '03-essai-actif');
      return `${subscriptionId}, statut « ${statusText} »`;
    });

    await step('webhook : vrais évènements signés envoyés au serveur bundlé', p, async () => {
      const customerId = aliceCustomer();
      const events = await customerEvents(customerId, startedAt, ['setup_intent.succeeded', 'customer.subscription.created']);
      const statuses = [];
      for (const event of events) {
        const payload = JSON.stringify(event);
        const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
        const response = await fetch(`${server.origin}/api/stripe/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': signature },
          body: payload,
        });
        statuses.push(`${event.type}=${response.status}`);
        check(response.status === 200, `webhook ${event.type} → ${response.status} ${await response.text()}`);
      }
      const subscriptions = (await stripe.subscriptions.list({ customer: customerId, status: 'all' })).data;
      check(subscriptions.length === 1, `${subscriptions.length} abonnements après le webhook`);
      return statuses.join(', ');
    });

    await step('résiliation : récapitulatif puis confirmation', p, async () => {
      await p.getByRole('button', { name: 'Résilier votre contrat' }).click();
      const dialog = p.getByRole('dialog', { name: 'Résilier votre contrat' });
      await dialog.waitFor({ timeout: 10_000 });
      const recap = plain(await dialog.innerText());
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const endDate = longDate(new Date(subscription.items.data[0].current_period_end * 1000));
      for (const expected of [ALICE.email, 'Abonnement RedView · 6 mois', subscriptionId, endDate]) {
        check(recap.includes(expected), `récapitulatif sans « ${expected} » : ${recap}`);
      }
      await shot(p, '04-resiliation');
      const defects = await auditA11y(p, 'résiliation');
      await dialog.getByRole('button', { name: 'Confirmer la résiliation' }).click();
      await p.getByRole('button', { name: 'Reprendre mon abonnement' }).waitFor({ timeout: 30_000 });
      const statusText = plain(await p.locator('.rvpb-subscription-status').innerText());
      check(statusText.startsWith('Résilié'), `statut après résiliation : ${statusText}`);
      const after = await stripe.subscriptions.retrieve(subscriptionId);
      check(after.cancel_at_period_end || after.cancel_at != null, 'Stripe : abonnement non résilié');
      await shot(p, '05-resilie');
      if (LIVE) {
        await expectEmail(server, 'SUBSCRIPTION-CANCELED', 'e-mail de résiliation');
      }
      return `${defects} défaut(s) axe dans la pop-in ; « ${statusText} »`;
    });

    await step('reprise de l’abonnement', p, async () => {
      await p.getByRole('button', { name: 'Reprendre mon abonnement' }).click();
      await p.getByRole('button', { name: 'Résilier votre contrat' }).waitFor({ timeout: 30_000 });
      const statusText = plain(await p.locator('.rvpb-subscription-status').innerText());
      check(/^Essai gratuit jusqu’au /.test(statusText), `statut après reprise : ${statusText}`);
      const after = await stripe.subscriptions.retrieve(subscriptionId);
      check(!after.cancel_at_period_end && after.cancel_at == null, 'Stripe : la résiliation est restée');
      return statusText;
    });

    await step('« Factures et reçus » → portail Stripe', p, async () => {
      await p.getByRole('button', { name: 'Factures et reçus' }).click();
      await p.waitForURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 60_000 });
      const url = new URL(p.url());
      await shot(p, '06-portail');
      await p.goto(`${server.origin}/?tab=subscription`);
      await p.getByRole('button', { name: 'Résilier votre contrat' }).waitFor({ timeout: 60_000 });
      return `${url.origin}${url.pathname.slice(0, 12)}…`;
    });

    if (LIVE) {
      await step('horloge : rappel de fin d’essai (trial_will_end → e-mail)', p, async () => {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const seen = new Set(listen.deliveries.keys());
        await advanceClock(testClock.id, subscription.trial_end - 2 * 86_400);
        const delivery = await listen.waitFor('customer.subscription.trial_will_end', { after: seen });
        check(delivery, 'customer.subscription.trial_will_end jamais relayé par stripe listen');
        check(delivery.status === 200, `trial_will_end → ${delivery.status}`);
        await expectEmail(server, 'TRIAL-ENDING', 'e-mail de fin d’essai');
        live.trialWillEnd = delivery.id;
        return `${delivery.id} → 200, e-mail envoyé (delivered@resend.dev)`;
      });

      await step('horloge : fin d’essai → abonnement payé et actif', p, async () => {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const seen = new Set(listen.deliveries.keys());
        await advanceClock(testClock.id, subscription.trial_end + 3600);
        const paid = await listen.waitFor('invoice.paid', { after: seen });
        check(paid, 'invoice.paid jamais relayé après la fin de l’essai');
        check(paid.status === 200, `invoice.paid → ${paid.status}`);
        const after = await stripe.subscriptions.retrieve(subscriptionId);
        check(after.status === 'active', `statut Stripe après l’essai : ${after.status}`);
        await p.goto(`${server.origin}/?tab=subscription`);
        const status = p.locator('.rvpb-subscription-status');
        await status.waitFor({ timeout: 60_000 });
        const renewal = longDate(new Date(after.items.data[0].current_period_end * 1000));
        const statusText = plain(await status.innerText());
        check(statusText.startsWith(`Formule 6 mois, renouvelée automatiquement le ${renewal}`), `statut affiché : ${statusText} (attendu le ${renewal})`);
        await shot(p, '06b-abonnement-actif');
        return statusText;
      });

      await step('horloge : rappel de reconduction (invoice.upcoming → e-mail)', p, async () => {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const periodEnd = subscription.items.data[0].current_period_end;
        // L.215-1 : information entre 3 mois et 1 mois avant l'échéance. Le délai
        // d'invoice.upcoming (Dashboard → Billing → « Upcoming renewal events »)
        // doit donc valoir au moins 30 jours : l'horloge s'arrête juste après
        // J-30 et l'évènement doit déjà être parti. Un saut direct plus loin le
        // rattraperait sans dire quand il a été émis.
        const seen = new Set(listen.deliveries.keys());
        await advanceClock(testClock.id, periodEnd - 29 * 86_400 - 12 * 3600);
        let upcoming = await listen.waitFor('invoice.upcoming', { after: seen, timeoutMs: 60_000 });
        if (!upcoming) {
          // Mesure du délai réel, pour le message d'échec.
          const later = new Set(listen.deliveries.keys());
          await advanceClock(testClock.id, periodEnd - 2 * 86_400);
          const late = await listen.waitFor('invoice.upcoming', { after: later, timeoutMs: 60_000 });
          live.renewal = late
            ? 'émis après J-30 (délai « Upcoming renewal events » < 30 jours dans le Dashboard : trop tard pour L.215-1)'
            : 'aucun invoice.upcoming jusqu’à J-2';
          check(false, live.renewal);
        }
        check(upcoming.status === 200, `invoice.upcoming → ${upcoming.status}`);
        await expectEmail(server, 'RENEWAL-REMINDER', 'e-mail de reconduction');
        live.renewal = 'émis avant J-29 (délai ≥ 30 jours, conforme L.215-1)';
        return `${upcoming.id} → 200, e-mail envoyé ; ${live.renewal}`;
      });
    }

    // ── Second compte : 3-D Secure refusé ───────────────────────────────────
    const carol = await openAccount(path.join(workDir, 'carol'), server.origin, CAROL, JWT.carol);
    contexts.push(carol.context);
    browserBackends.push(carol);
    page = carol.page;
    pageWatch(page, 'carol');
    const q = page;

    await step('3-D Secure refusé : message d’erreur, aucun abonnement', q, async () => {
      await q.goto(`${server.origin}/?tab=subscription`);
      await planCard(q, '1 mois').getByRole('button', { name: 'Choisir' }).click();
      const submit = q.getByRole('button', { name: /^Démarrer l’essai gratuit/ });
      await submit.waitFor({ timeout: 30_000 });
      await fillCard(q, '4000 0027 6000 3184');
      // Contre-épreuve du clic perdu : un clic hors de l'iframe (le titre) d'abord,
      // puis la case — perdue elle aussi ou non (relevé dans le rapport).
      await q.getByRole('heading', { name: 'Démarrer votre essai gratuit' }).click();
      const consent = q.getByRole('checkbox');
      await consent.click();
      checkboxClickLostAfterOutsideClick = !(await consent.isChecked());
      if (checkboxClickLostAfterOutsideClick) await consent.check();
      await submit.click();

      // Défi 3DS : iframe de Stripe (hooks.stripe.com) avec « Fail » / « Échec ».
      const deadline = Date.now() + 60_000;
      let failedChallenge = false;
      while (!failedChallenge) {
        for (const frame of q.frames()) {
          const button = frame.locator('#test-source-fail-3ds');
          if (await button.count().catch(() => 0)) {
            // Le bouton est dans le DOM pendant l'animation d'ouverture de Stripe :
            // attendre qu'il soit visible, puis cliquer jusqu'à ce que le défi se ferme.
            await button.waitFor({ state: 'visible', timeout: 20_000 });
            await shot(q, '07-defi-3ds');
            for (let attempt = 0; attempt < 5 && !failedChallenge; attempt++) {
              await button.click({ timeout: 5_000 }).catch(() => undefined);
              failedChallenge = await button.waitFor({ state: 'detached', timeout: 4_000 }).then(() => true, () => false);
            }
            check(failedChallenge, 'défi 3-D Secure : « FAIL » cliqué sans effet');
            break;
          }
        }
        if (failedChallenge) break;
        check(Date.now() < deadline, `défi 3-D Secure jamais affiché ; cadres : ${q.frames().map((f) => f.url().slice(0, 80)).join(' | ')}`);
        await sleep(500);
      }

      const alert = q.locator('.rvpb-billing-page__error[role="alert"]');
      await alert.waitFor({ timeout: 30_000 });
      const message = plain(await alert.innerText());
      await shot(q, '08-3ds-refuse');
      const customerId = appwriteServer.customerIdFor(CAROL.$id);
      check(customerId, 'aucun client Stripe pour le second compte');
      const subscriptions = (await stripe.subscriptions.list({ customer: customerId, status: 'all' })).data;
      check(subscriptions.length === 0, `${subscriptions.length} abonnement(s) créé(s) malgré l'échec 3DS`);
      return `« ${message} »`;
    });

    await step('contrôles globaux', null, async () => {
      check(pageErrors.length === 0, `erreurs de page : ${pageErrors.slice(0, 5).join(' | ')}`);
      const unhandledBrowser = browserBackends.flatMap((backend) => backend.appwrite.state.unhandled);
      check(unhandledBrowser.length === 0, `appels Appwrite (navigateur) non simulés : ${unhandledBrowser.slice(0, 5).join(', ')}`);
      check(appwriteServer.state.unhandled.length === 0, `appels Appwrite (serveur) non simulés : ${appwriteServer.state.unhandled.slice(0, 5).join(', ')}`);
      const cspReports = browserBackends.flatMap((backend) => backend.telemetry.cspReports);
      check(cspReports.length === 0 && cspConsole.length === 0, `violations CSP : ${[...cspReports, ...cspConsole].slice(0, 6).join(' | ')}`);
      const reported = browserBackends.flatMap((backend) => backend.telemetry.errors);
      check(reported.length === 0, `erreurs envoyées à GlitchTip : ${reported.slice(0, 5).join(' | ')}`);
      // Seule erreur attendue : le journal de l'app quand le 3-D Secure est refusé (second compte).
      const unexpected = consoleErrors.filter((line) => !line.startsWith('[carol] [billing-ui] billing-page-submit-error'));
      check(unexpected.length === 0, `erreurs console : ${unexpected.slice(0, 6).join(' | ')}`);
      if (listen) {
        const refused = [...listen.deliveries].filter(([, delivery]) => delivery.status !== null && delivery.status !== 200);
        check(refused.length === 0, `webhooks relayés refusés : ${refused.slice(0, 6).map(([id, d]) => `${d.type} ${id} → ${d.status}`).join(' | ')}`);
      }
      check(a11yFindings.length === 0, `défauts axe : ${a11yFindings.map((f) => `${f.screen} ${f.rule} (${f.targets.length}) ${f.targets.slice(0, 2).join(', ')}`).join(' | ')}`);
    });
  } catch (error) {
    failed = true;
    if (!(error instanceof CheckError)) console.error(error);
    if (pageErrors.length) console.log(`Erreurs de page :\n  ${pageErrors.join('\n  ')}`);
    if (consoleErrors.length) console.log(`Erreurs console :\n  ${consoleErrors.slice(0, 20).join('\n  ')}`);
    if (cspConsole.length) console.log(`CSP (console) :\n  ${cspConsole.slice(0, 20).join('\n  ')}`);
    const serverLog = server.log().split('\n').filter((line) => /error|warn|billing|stripe/i.test(line)).slice(-30);
    if (serverLog.length) console.log(`Journal du serveur (extrait) :\n  ${serverLog.join('\n  ')}`);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await server.stop();
    if (listen) await listen.stop();
    const clockCustomer = testClock ? appwriteServer.customerIdFor(ALICE.$id) : null;
    if (testClock) {
      await stripe.testHelpers.testClocks.del(testClock.id).catch((error) => console.warn(`horloge ${testClock.id} non supprimée : ${error.message}`));
    }
    // Les clients de l'horloge partent avec elle.
    const customers = appwriteServer.stripeCustomerIds().filter((id) => id !== clockCustomer);
    for (const customerId of customers) {
      await stripe.customers.del(customerId).catch((error) => console.warn(`client ${customerId} non supprimé : ${error.message}`));
    }
    await appwriteServer.stop();
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
    const report = {
      at: new Date().toISOString(),
      channel: CHANNEL,
      ok: !failed,
      steps: results,
      a11y: a11yFindings,
      pageErrors,
      consoleErrors,
      csp: cspConsole,
      cspStripePages: cspThirdParty,
      paymentElementDefaultTab: openedTab,
      firstSubmitClickLostAfterCardEntry: firstClickLost,
      firstClickEvents: clickProbe,
      checkboxClickLostAfterOutsideClick,
      stripeCustomersDeleted: customers,
      live: LIVE
        ? {
            testClock: testClock?.id ?? null,
            renewal: live.renewal,
            deliveries: listen ? [...listen.deliveries].map(([id, delivery]) => ({ id, ...delivery })) : [],
          }
        : null,
    };
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${failed ? '✖ échec' : '✔ parcours de paiement OK'} — rapport : ${path.relative(REPO, REPORT_DIR)}/report.json ; ${customers.length} client(s) Stripe supprimé(s)`);
  }
  process.exit(failed ? 1 : 0);
}

await main();
