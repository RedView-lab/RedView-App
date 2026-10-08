import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicError } from './errors.js';
import { sendAccountDeletionCodeEmail, sendVerificationEmail } from './mailer.ts';

interface SecureCodeEntry {
  codeHash: string; // SHA-256(salt:code)
  salt: string;
  name?: string;
  expiresAt: number;
  attempts: number;
  lastRequestedAt: number;
}

/**
 * Compteurs par e-mail (normalisé) qui survivent à la suppression du code :
 *  - `requests`  : horodatages des demandes de code (fenêtre glissante 1 h),
 *  - `failures`  : horodatages des essais ratés (fenêtre glissante 24 h),
 *  - `lockedUntil` : verrouillage 24 h après trop d'échecs (0 = pas de verrou).
 */
interface EmailQuotaEntry {
  requests: number[];
  failures: number[];
  lockedUntil: number;
}

interface PersistedStore {
  version: 2;
  codes: Record<string, SecureCodeEntry>;
  quotas: Record<string, EmailQuotaEntry>;
}

interface VerificationState {
  codes: Map<string, SecureCodeEntry>;
  quotas: Map<string, EmailQuotaEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  exitHooked: boolean;
}

// ────────────────────────────── Politique ──────────────────────────────

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS_PER_CODE = 5;
const REQUEST_COOLDOWN_MS = 30 * 1000;
const REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 h glissante
const MAX_REQUESTS_PER_WINDOW = 5;
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h glissantes
const MAX_FAILURES_PER_WINDOW = 10;
const LOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const FLUSH_DEBOUNCE_MS = 250;

export const VERIFICATION_LOCKED_MESSAGE =
  'Trop de tentatives pour cette adresse e-mail. Veuillez réessayer plus tard.';

// ────────────────────────────── Persistance ──────────────────────────────

const STORE_FILE = path.join(os.tmpdir(), 'redview_auth_verification_vault.json');

function hashVerificationCode(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function readDiskStore(): PersistedStore {
  const empty: PersistedStore = { version: 2, codes: {}, quotas: {} };
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedStore> | null;
      // L'ancien format (codes à 4 chiffres, map plate) est ignoré : ces codes
      // ne passent de toute façon plus la validation à 6 chiffres.
      if (parsed && parsed.version === 2 && parsed.codes && parsed.quotas) {
        return { version: 2, codes: parsed.codes, quotas: parsed.quotas };
      }
    }
  } catch (err) {
    console.warn('[verificationStore] Error reading secure store file:', err);
  }
  return empty;
}

function writeDiskStore(data: PersistedStore) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data), {
      encoding: 'utf-8',
      mode: 0o600, // Restreint l'accès au fichier au seul propriétaire
    });
  } catch (err) {
    console.warn('[verificationStore] Error writing secure store file:', err);
  }
}

// État global en mémoire pour survivre aux invalidations de modules SSR de Vite en dev.
// Le disque n'est lu qu'une fois au démarrage : la mémoire fait foi ensuite
// (un process unique en prod), ce qui évite de « ressusciter » un code
// consommé/invalidé tant que l'écriture différée n'a pas eu lieu.
const globalForVerification = globalThis as unknown as {
  __rv_verification_state_v2?: VerificationState;
};

if (!globalForVerification.__rv_verification_state_v2) {
  const initialData = readDiskStore();
  globalForVerification.__rv_verification_state_v2 = {
    codes: new Map(Object.entries(initialData.codes)),
    quotas: new Map(Object.entries(initialData.quotas)),
    flushTimer: null,
    exitHooked: false,
  };
}

const state: VerificationState = globalForVerification.__rv_verification_state_v2;

function flushNow() {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  writeDiskStore({
    version: 2,
    codes: Object.fromEntries(state.codes),
    quotas: Object.fromEntries(state.quotas),
  });
}

/** Écriture disque différée (debounce) au lieu d'un writeFileSync par mutation. */
function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof state.flushTimer.unref === 'function') {
    state.flushTimer.unref();
  }
}

if (!state.exitHooked) {
  state.exitHooked = true;
  const flushIfPending = () => {
    if (state.flushTimer) flushNow();
  };
  process.on('beforeExit', flushIfPending);
  // 'exit' n'autorise que du synchrone : writeFileSync convient.
  process.on('exit', flushIfPending);
}

// ────────────────────────────── Accès aux maps ──────────────────────────────

function setCode(email: string, entry: SecureCodeEntry) {
  state.codes.set(email, entry);
  scheduleFlush();
}

function deleteCode(email: string) {
  if (state.codes.delete(email)) scheduleFlush();
}

/** Retourne l'entrée de quota de l'e-mail, purgée des horodatages expirés. */
function getQuota(email: string, now: number): EmailQuotaEntry {
  const existing = state.quotas.get(email);
  if (!existing) {
    return { requests: [], failures: [], lockedUntil: 0 };
  }
  return {
    requests: (existing.requests ?? []).filter((t) => now - t < REQUEST_WINDOW_MS),
    failures: (existing.failures ?? []).filter((t) => now - t < FAILURE_WINDOW_MS),
    lockedUntil: existing.lockedUntil > now ? existing.lockedUntil : 0,
  };
}

function isQuotaEmpty(entry: EmailQuotaEntry): boolean {
  return entry.requests.length === 0 && entry.failures.length === 0 && entry.lockedUntil === 0;
}

function saveQuota(email: string, entry: EmailQuotaEntry) {
  if (isQuotaEmpty(entry)) {
    state.quotas.delete(email);
  } else {
    state.quotas.set(email, entry);
  }
  scheduleFlush();
}

// Nettoie périodiquement les entrées expirées
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of state.codes.entries()) {
    if (entry.expiresAt < now) {
      state.codes.delete(key);
      changed = true;
    }
  }
  for (const [key, current] of Array.from(state.quotas.entries())) {
    const pruned = getQuota(key, now);
    if (isQuotaEmpty(pruned)) {
      state.quotas.delete(key);
      changed = true;
    } else if (
      pruned.requests.length !== (current.requests ?? []).length ||
      pruned.failures.length !== (current.failures ?? []).length ||
      pruned.lockedUntil !== current.lockedUntil
    ) {
      state.quotas.set(key, pruned);
      changed = true;
    }
  }
  if (changed) {
    scheduleFlush();
  }
}, 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

// ────────────────────────────── API publique ──────────────────────────────

export function normalizeVerificationEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generate6DigitCode(): string {
  // 6 chiffres aléatoires cryptographiquement sûrs (000000 - 999999)
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Vérifie et consomme le quota de demandes d'un e-mail (verrou 24 h, cooldown
 * 30 s, max 5 demandes / heure glissante). À appeler AVANT toute action
 * (envoi de code ou e-mail « compte existant ») pour que les deux chemins
 * soient limités de la même façon et indiscernables.
 *
 * @throws PublicError (429) si la demande doit être refusée.
 */
export function consumeVerificationRequestQuota(email: string): void {
  const normalizedEmail = normalizeVerificationEmail(email);
  const now = Date.now();
  const quota = getQuota(normalizedEmail, now);

  if (quota.lockedUntil > now) {
    throw new PublicError(VERIFICATION_LOCKED_MESSAGE, 429);
  }

  const lastRequestAt = quota.requests.length > 0 ? Math.max(...quota.requests) : 0;
  if (lastRequestAt && now - lastRequestAt < REQUEST_COOLDOWN_MS) {
    const waitSec = Math.ceil((REQUEST_COOLDOWN_MS - (now - lastRequestAt)) / 1000);
    throw new PublicError(`Veuillez patienter ${waitSec}s avant de redemander un code.`, 429);
  }

  if (quota.requests.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new PublicError(
      'Trop de demandes de code pour cette adresse e-mail. Veuillez réessayer dans une heure.',
      429,
    );
  }

  quota.requests.push(now);
  saveQuota(normalizedEmail, quota);
}

/** Nouveau code pour `key` (remplace le précédent), rendu en clair pour l'e-mail. */
function issueCode(key: string, name?: string): string {
  const now = Date.now();
  const code = generate6DigitCode();
  const salt = crypto.randomBytes(16).toString('hex');
  setCode(key, {
    codeHash: hashVerificationCode(code, salt),
    salt,
    name,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    lastRequestedAt: now,
  });
  return code;
}

/**
 * Clé des codes de suppression de compte : séparée de celle des codes
 * d'inscription (même e-mail, autre usage), avec ses propres quotas.
 */
export function accountDeletionCodeKey(email: string): string {
  return `account-deletion:${normalizeVerificationEmail(email)}`;
}

/**
 * Code de confirmation d'une suppression de compte, envoyé à l'adresse du
 * compte. Quota consommé au préalable (`consumeVerificationRequestQuota` sur
 * `accountDeletionCodeKey`) ; vérifié par `validateVerificationCode` sur la
 * même clé.
 */
export async function requestAccountDeletionCode(email: string, name?: string): Promise<{ sent: boolean }> {
  const code = issueCode(accountDeletionCodeKey(email), name);
  return sendAccountDeletionCodeEmail({ to: normalizeVerificationEmail(email), code, name });
}

/**
 * Génère un nouveau code (remplace le précédent) et l'envoie par e-mail.
 * Le quota doit avoir été consommé au préalable via
 * `consumeVerificationRequestQuota`.
 */
export async function requestVerificationCode(
  email: string,
  name?: string,
): Promise<{ sent: boolean }> {
  const normalizedEmail = normalizeVerificationEmail(email);
  const code = issueCode(normalizedEmail, name);

  const mailResult = await sendVerificationEmail({
    to: normalizedEmail,
    code,
    name,
  });

  return { sent: mailResult.sent };
}

type CodeCheck = { valid: boolean; error?: string; status?: number };

/**
 * Vérifie un code et le consomme s'il est bon (usage unique). Les essais
 * ratés comptent dans le quota de l'e-mail.
 */
export function validateVerificationCode(email: string, inputCode: string): CodeCheck {
  const check = checkVerificationCode(email, inputCode);
  if (check.valid) consumeVerificationCode(email);
  return check;
}

/** Consomme le code en cours de `email` (après l'action qu'il autorisait). */
export function consumeVerificationCode(email: string): void {
  deleteCode(normalizeVerificationEmail(email));
}

/**
 * Comme `validateVerificationCode`, sans consommer un code bon : pour une
 * action qui peut échouer après la vérification (création du compte), le
 * code reste valable pour un nouvel essai jusqu'à `consumeVerificationCode`.
 */
export function checkVerificationCode(email: string, inputCode: string): CodeCheck {
  const normalizedEmail = normalizeVerificationEmail(email);
  const cleanInput = inputCode.trim();
  const now = Date.now();
  const quota = getQuota(normalizedEmail, now);

  if (quota.lockedUntil > now) {
    return { valid: false, error: VERIFICATION_LOCKED_MESSAGE, status: 429 };
  }

  const entry = state.codes.get(normalizedEmail);

  if (!entry) {
    return {
      valid: false,
      error: 'Aucun code trouvé pour cet e-mail. Veuillez en demander un nouveau.',
    };
  }

  if (now > entry.expiresAt) {
    deleteCode(normalizedEmail);
    return {
      valid: false,
      error: 'Le code a expiré. Veuillez en redemander un nouveau.',
    };
  }

  // 5 essais au plus par code, contre la force brute
  if (entry.attempts >= MAX_ATTEMPTS_PER_CODE) {
    deleteCode(normalizedEmail);
    return {
      valid: false,
      error: 'Trop de tentatives incorrectes. Le code a été invalidé par sécurité. Veuillez en demander un nouveau.',
    };
  }

  // Calcule l'empreinte SHA-256 salée
  const computedHash = hashVerificationCode(cleanInput, entry.salt);

  // Comparaison en temps constant (résistante aux attaques temporelles)
  const expectedBuf = Buffer.from(entry.codeHash, 'utf-8');
  const inputBuf = Buffer.from(computedHash, 'utf-8');

  const isMatch =
    expectedBuf.length === inputBuf.length &&
    crypto.timingSafeEqual(expectedBuf, inputBuf);

  if (!isMatch) {
    // Compteur cumulatif par e-mail (survit à la suppression du code)
    quota.failures.push(now);
    if (quota.failures.length >= MAX_FAILURES_PER_WINDOW) {
      quota.lockedUntil = now + LOCK_DURATION_MS;
      saveQuota(normalizedEmail, quota);
      deleteCode(normalizedEmail);
      return { valid: false, error: VERIFICATION_LOCKED_MESSAGE, status: 429 };
    }
    saveQuota(normalizedEmail, quota);

    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS_PER_CODE) {
      deleteCode(normalizedEmail);
      return {
        valid: false,
        error: 'Code invalide. Nombre maximal d’essais atteint, code invalidé.',
      };
    }
    setCode(normalizedEmail, entry);
    return {
      valid: false,
      error: `Code invalide (${MAX_ATTEMPTS_PER_CODE - entry.attempts} essai(s) restant(s)).`,
    };
  }

  return { valid: true };
}
