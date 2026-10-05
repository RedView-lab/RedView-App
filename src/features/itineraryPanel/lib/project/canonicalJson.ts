/**
 * JSON canonique : clés d'objet triées, `undefined` omis (comme JSON). Deux
 * valeurs égales donnent la même chaîne quel que soit l'ordre d'insertion de
 * leurs clés — indispensable pour les estampilles (tracé, prédiction) : un
 * document fusionné (co-édition) ne garantit pas l'ordre des clés d'un objet.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const inner = source[key];
    if (inner !== undefined) out[key] = canonicalize(inner);
  }
  return out;
}
