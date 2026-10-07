/** Longueur maximale d'une adresse e-mail (RFC 5321). */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Adresse e-mail reçue d'un client, normalisée comme Appwrite la compare
 * (espaces retirés, minuscules) ; `null` si ce n'est pas une adresse.
 */
export function parseEmailAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}
