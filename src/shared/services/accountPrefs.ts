/**
 * Sports du compte (préférences utilisateur Appwrite `sports[].sport`, stockés
 * en libellés français).
 */

/** Libellés renommés ou fusionnés au fil du temps → libellé actuel. */
const LEGACY_SPORT_ALIASES: Record<string, string> = {
  Randonnee: 'Trail',
};

export function normalizeAccountSportLabel(label: string): string {
  return LEGACY_SPORT_ALIASES[label] ?? label;
}
