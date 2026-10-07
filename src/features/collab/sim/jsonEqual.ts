/**
 * Égalité « même JSON canonique » sans construire de chaîne : vrai si et
 * seulement si `canonicalJson(a) === canonicalJson(b)` (clés dans n'importe
 * quel ordre, `undefined` et fonctions absents d'un objet et `null` dans un
 * tableau, nombres non finis `null`, `-0` égal à `0`). Le vérificateur du
 * simulateur compare ainsi deux documents entiers après chaque action :
 * deux `canonicalJson` (tri des clés de chaque objet, chaînes de plusieurs
 * centaines de Ko) faisaient 40 % du temps de `bench:collab`.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Seule, une valeur omise s'écrit `null` (canonicalJson), comme dans un tableau.
  const ja = jsonValue(arrayItem(a));
  const jb = jsonValue(arrayItem(b));
  if (ja === jb) return true;
  if (typeof ja !== 'object' || typeof jb !== 'object' || ja === null || jb === null) return false;
  if (Array.isArray(ja) || Array.isArray(jb)) {
    if (!Array.isArray(ja) || !Array.isArray(jb) || ja.length !== jb.length) return false;
    for (let index = 0; index < ja.length; index += 1) {
      if (!jsonEqual(arrayItem(ja[index]), arrayItem(jb[index]))) return false;
    }
    return true;
  }
  const ra = ja as Record<string, unknown>;
  const rb = jb as Record<string, unknown>;
  let count = 0;
  for (const key of Object.keys(ra)) {
    const value = ra[key];
    if (isOmitted(value)) continue;
    count += 1;
    if (!Object.hasOwn(rb, key) || isOmitted(rb[key]) || !jsonEqual(value, rb[key])) return false;
  }
  for (const key of Object.keys(rb)) if (!isOmitted(rb[key])) count -= 1;
  return count === 0;
}

/** Ce qu'un objet devient en JSON : absent. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/** Ce qu'un élément de tableau devient en JSON : `null` s'il serait omis d'un objet. */
function arrayItem(value: unknown): unknown {
  return isOmitted(value) ? null : value;
}

/** Valeur primitive telle que JSON l'écrit (nombre non fini → null, -0 → 0). */
function jsonValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  return value;
}
