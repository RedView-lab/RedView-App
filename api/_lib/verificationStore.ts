import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendVerificationEmail } from './mailer.js';

interface SecureCodeEntry {
  codeHash: string; // SHA-256(salt:code)
  salt: string;
  name?: string;
  expiresAt: number;
  attempts: number;
  lastRequestedAt: number;
}

const STORE_FILE = path.join(os.tmpdir(), 'redview_auth_verification_vault.json');

function hashVerificationCode(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function readDiskStore(): Record<string, SecureCodeEntry> {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[verificationStore] Error reading secure store file:', err);
  }
  return {};
}

function writeDiskStore(data: Record<string, SecureCodeEntry>) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data), {
      encoding: 'utf-8',
      mode: 0o600, // Restrict file access to owner only
    });
  } catch (err) {
    console.warn('[verificationStore] Error writing secure store file:', err);
  }
}

// Global in-memory fallback to survive Vite SSR module invalidations in dev
const globalForVerification = globalThis as unknown as {
  __rv_verification_store?: Map<string, SecureCodeEntry>;
};

if (!globalForVerification.__rv_verification_store) {
  const initialData = readDiskStore();
  globalForVerification.__rv_verification_store = new Map(Object.entries(initialData));
}

const store: Map<string, SecureCodeEntry> = globalForVerification.__rv_verification_store;

function syncStore() {
  const obj: Record<string, SecureCodeEntry> = {};
  for (const [key, val] of store.entries()) {
    obj[key] = val;
  }
  writeDiskStore(obj);
}

function getEntry(email: string): SecureCodeEntry | undefined {
  let entry = store.get(email);
  if (!entry) {
    // Check disk in case another process/worker wrote it
    const disk = readDiskStore();
    if (disk[email]) {
      entry = disk[email];
      store.set(email, entry);
    }
  }
  return entry;
}

function setEntry(email: string, entry: SecureCodeEntry) {
  store.set(email, entry);
  syncStore();
}

function deleteEntry(email: string) {
  store.delete(email);
  syncStore();
}

// Clean expired entries periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) {
    syncStore();
  }
}, 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

export function generate4DigitCode(): string {
  // Cryptographically secure random 4 digits (1000 - 9999)
  return crypto.randomInt(1000, 10000).toString();
}

export async function requestVerificationCode(
  email: string,
  name?: string,
): Promise<{ success: boolean; debugCode?: string; message?: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = getEntry(normalizedEmail);
  const now = Date.now();

  // Rate limit: 30s cooldown between code generation requests for the same email
  if (existing && existing.lastRequestedAt && now - existing.lastRequestedAt < 30 * 1000) {
    const waitSec = Math.ceil((30 * 1000 - (now - existing.lastRequestedAt)) / 1000);
    throw new Error(`Veuillez patienter ${waitSec}s avant de redemander un code.`);
  }

  const code = generate4DigitCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const codeHash = hashVerificationCode(code, salt);
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes

  setEntry(normalizedEmail, {
    codeHash,
    salt,
    name,
    expiresAt,
    attempts: 0,
    lastRequestedAt: now,
  });

  const mailResult = await sendVerificationEmail({
    to: normalizedEmail,
    code,
    name,
  });

  return {
    success: true,
    message: mailResult.sent
      ? 'Verification code sent to email'
      : 'Code generated and ready for verification',
  };
}

export function validateVerificationCode(
  email: string,
  inputCode: string,
): { valid: boolean; error?: string } {
  const normalizedEmail = email.trim().toLowerCase();
  const cleanInput = inputCode.trim();
  const entry = getEntry(normalizedEmail);

  if (!entry) {
    return {
      valid: false,
      error: 'Aucun code trouvé pour cet e-mail. Veuillez en demander un nouveau.',
    };
  }

  if (Date.now() > entry.expiresAt) {
    deleteEntry(normalizedEmail);
    return {
      valid: false,
      error: 'Le code a expiré. Veuillez en redemander un nouveau.',
    };
  }

  // Maximum 3 attempts to prevent brute-forcing
  if (entry.attempts >= 3) {
    deleteEntry(normalizedEmail);
    return {
      valid: false,
      error: 'Trop de tentatives incorrectes. Le code a été invalidé par sécurité. Veuillez en demander un nouveau.',
    };
  }

  // Compute salted SHA-256 hash
  const computedHash = hashVerificationCode(cleanInput, entry.salt);

  // Timing-safe constant-time comparison
  const expectedBuf = Buffer.from(entry.codeHash, 'utf-8');
  const inputBuf = Buffer.from(computedHash, 'utf-8');

  const isMatch =
    expectedBuf.length === inputBuf.length &&
    crypto.timingSafeEqual(expectedBuf, inputBuf);

  if (!isMatch) {
    entry.attempts += 1;
    if (entry.attempts >= 3) {
      deleteEntry(normalizedEmail);
      return {
        valid: false,
        error: 'Code invalide. Nombre maximal d’essais atteint, code invalidé.',
      };
    }
    setEntry(normalizedEmail, entry);
    return {
      valid: false,
      error: `Code invalide (${3 - entry.attempts} essai(s) restant(s)).`,
    };
  }

  // Code is valid! Consume it immediately (One-Time Token)
  deleteEntry(normalizedEmail);
  return { valid: true };
}
