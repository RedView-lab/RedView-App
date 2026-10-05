import { translateAppText } from '@/shared/i18n';

/**
 * `name` s'il est libre, sinon `name (importé)`, `name (importé 2)`…
 * (`taken` : noms déjà pris, rognés et en minuscules). Jamais un « (2) » nu :
 * Rethink Sans l'affiche en chiffre cerclé ② (alternatives contextuelles).
 */
export function nextFreeName(name: string, taken: ReadonlySet<string>): string {
  const isTaken = (candidate: string) => taken.has(candidate.trim().toLowerCase());
  if (!isTaken(name)) return name;
  const label = translateAppText('importé');
  let candidate = `${name.trimEnd()} (${label})`;
  for (let suffix = 2; isTaken(candidate); suffix += 1) {
    candidate = `${name.trimEnd()} (${label} ${suffix})`;
  }
  return candidate;
}

/** Nom du projet importé (gardé tel quel s'il est libre dans le dossier de destination). */
export function buildImportedProjectName(baseName: string, siblingNames: readonly string[]): string {
  const base = baseName.trim() ? baseName : translateAppText('Projet importé');
  return nextFreeName(base, new Set(siblingNames.map((name) => name.trim().toLowerCase())));
}
