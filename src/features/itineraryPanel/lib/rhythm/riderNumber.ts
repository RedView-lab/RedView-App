/**
 * Saisie des cartes numériques du rythme (FTP, poids total) : « 82,5 » comme
 * « 82.5 », espaces ignorés (« 1 200 »). Le champ bloquait toute touche autre
 * qu'un chiffre : « 82,5 » devenait 825 kg sans un mot, et la prédiction de
 * temps avec. Une valeur hors des bornes n'est pas retenue.
 */

export interface RiderNumberRule {
  /** Décimales acceptées (0 = entier). */
  decimals: number;
  min: number;
  max: number;
}

export const FTP_RULE: RiderNumberRule = { decimals: 0, min: 50, max: 2000 };
/** Cycliste + vélo + bagages. */
export const SYSTEM_WEIGHT_RULE: RiderNumberRule = { decimals: 1, min: 30, max: 250 };

export type RiderNumberParse =
  /** Champ vide : pas de valeur (« N/A »). */
  | { kind: 'empty' }
  | { kind: 'value'; value: number }
  /** Saisie incomplète ou hors bornes : rien n'est retenu. */
  | { kind: 'invalid' };

export function parseRiderNumber(text: string, rule: RiderNumberRule): RiderNumberParse {
  const compact = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!compact) return { kind: 'empty' };
  // « 82. » ou « 82, » en cours de frappe : 82.
  const pattern = rule.decimals > 0 ? new RegExp(`^\\d+(\\.\\d{0,${rule.decimals}})?$`) : /^\d+$/;
  if (!pattern.test(compact)) return { kind: 'invalid' };
  const value = Number.parseFloat(compact);
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) return { kind: 'invalid' };
  return { kind: 'value', value };
}

/** Caractères qu'une frappe peut ajouter : chiffres, et le séparateur décimal si la règle en a. */
export function isRiderNumberKey(key: string, rule: RiderNumberRule): boolean {
  return /^\d$/.test(key) || (rule.decimals > 0 && (key === ',' || key === '.'));
}

export function formatRiderNumber(value: number, rule: RiderNumberRule, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: rule.decimals, useGrouping: false }).format(value);
}
