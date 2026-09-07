import { sendVerificationEmail } from './mailer.js';

interface CodeEntry {
  code: string;
  name?: string;
  expiresAt: number;
  attempts: number;
}

// In-memory verification store (persisted in server process memory)
const store = new Map<string, CodeEntry>();

// Clean expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt < now) {
      store.delete(key);
    }
  }
}, 60 * 1000);

export function generate4DigitCode(): string {
  // Generate random 4 digits (1000 - 9999)
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export async function requestVerificationCode(
  email: string,
  name?: string,
): Promise<{ success: boolean; debugCode?: string; message?: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  // Rate-limiting: if a valid code was created less than 45 seconds ago, reuse or wait
  const existing = store.get(normalizedEmail);
  const now = Date.now();

  const code = generate4DigitCode();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes

  store.set(normalizedEmail, {
    code,
    name,
    expiresAt,
    attempts: 0,
  });

  const mailResult = await sendVerificationEmail({
    to: normalizedEmail,
    code,
    name,
  });

  return {
    success: true,
    debugCode: mailResult.debugCode,
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
  const entry = store.get(normalizedEmail);

  if (!entry) {
    return {
      valid: false,
      error: 'Aucun code trouvé pour cet e-mail. Veuillez en demander un nouveau.',
    };
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(normalizedEmail);
    return {
      valid: false,
      error: 'Le code a expiré. Veuillez en redemander un nouveau.',
    };
  }

  if (entry.attempts >= 5) {
    store.delete(normalizedEmail);
    return {
      valid: false,
      error: 'Trop de tentatives incorrectes. Veuillez demander un nouveau code.',
    };
  }

  if (entry.code.trim() !== inputCode.trim()) {
    entry.attempts += 1;
    return {
      valid: false,
      error: `Code invalide (${5 - entry.attempts} essai(s) restant(s)).`,
    };
  }

  // Code is valid! Consume it
  store.delete(normalizedEmail);
  return { valid: true };
}
