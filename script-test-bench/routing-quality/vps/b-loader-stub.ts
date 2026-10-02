/** Remplace ../../audit/b-loader.ts dans le bundle VPS : pas de Vite, racine = dossier courant. */
export const ROOT = process.cwd();

export async function loadSrc(): Promise<never> {
  throw new Error('loadSrc indisponible dans le bundle VPS (imports statiques, voir app-static.ts)');
}

export async function closeLoader(): Promise<void> {}
