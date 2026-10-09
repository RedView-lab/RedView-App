/**
 * Nom de fichier d'export sûr sous Windows, macOS et Linux, au format court
 * « tour-du-mont-blanc » (minuscules, tirets, accents latins retirés).
 * Les lettres et chiffres de toute écriture sont gardés : un projet
 * « 東京ライド » ou « Ελλάδα » s'exportait en « itinerary.gpx », faute de
 * lettres ASCII. Longueur bornée (les noms de projet ne le sont pas), noms
 * réservés de Windows évités. `fallback` quand rien ne reste (émojis seuls).
 */
const MAX_BASE_LENGTH = 100;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function slugFileName(value: string, fallback: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    // \p{M} : signes combinants des écritures indiennes, thaï, arabe… (après NFC).
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  // Coupe sur un caractère entier (jamais au milieu d'une paire de substitution).
  const bounded = Array.from(slug).slice(0, MAX_BASE_LENGTH).join('').replace(/[-.]+$/g, '');
  if (!bounded) return fallback;
  return WINDOWS_RESERVED.test(bounded) ? `${bounded}-${fallback}` : bounded;
}
