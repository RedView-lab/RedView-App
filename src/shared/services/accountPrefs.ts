/**
 * Account sports (Appwrite user prefs `sports[].sport`, stored as French
 * labels).
 */

/** Labels renamed or merged over time → current label. */
const LEGACY_SPORT_ALIASES: Record<string, string> = {
  Randonnee: 'Trail',
};

export function normalizeAccountSportLabel(label: string): string {
  return LEGACY_SPORT_ALIASES[label] ?? label;
}
