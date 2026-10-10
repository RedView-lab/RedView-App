/**
 * Longueur maximale d'un nom de projet ou de dossier : l'attribut `name`
 * d'Appwrite fait 255 caractères (scripts/appwrite/setup-appwrite-schema.mjs),
 * comptés en points de code. Au-delà, l'écriture est refusée et la sauvegarde
 * du projet suspendue (D3-3).
 */
export const PROJECT_NAME_MAX_LENGTH = 255;

/** Nom coupé à PROJECT_NAME_MAX_LENGTH points de code (jamais au milieu d'un émoji codé sur deux unités). */
export function clampProjectName(name: string): string {
  if (name.length <= PROJECT_NAME_MAX_LENGTH) return name;
  const codePoints = Array.from(name);
  return codePoints.length <= PROJECT_NAME_MAX_LENGTH ? name : codePoints.slice(0, PROJECT_NAME_MAX_LENGTH).join('');
}
