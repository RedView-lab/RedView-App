/**
 * Lecture d'une valeur levée (`catch (err)` : `unknown`). Une `DOMException`
 * (OPFS, IndexedDB, fetch annulé) est une `Error` dans les navigateurs.
 */

/** Message d'une valeur levée ; `fallback` quand ce n'est pas une erreur ou que son message est vide. */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback ?? String(err);
}

/** Nom de l'erreur (`AbortError`, `NotFoundError`…), undefined si ce n'en est pas une. */
export function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}
