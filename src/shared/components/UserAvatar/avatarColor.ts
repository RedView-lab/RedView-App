/**
 * Couleur stable d'un utilisateur (co-édition) : pastille, curseur sur la
 * carte, cadre du suivi. Prise dans la palette des itinéraires
 * (itineraryPanel/lib/project/defaultState.ts, ITINERARY_COLORS).
 */
const AVATAR_COLORS = ['#c50000', '#ff8a3d', '#ffd13a', '#5ab95a', '#3d8bff', '#9b59ff'] as const;
/** Couleurs claires de la palette : texte foncé dessus (lisible). */
const LIGHT_COLORS = new Set<string>(['#ffd13a', '#ff8a3d']);

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

export function userAvatarColor(userId: string): string {
  return AVATAR_COLORS[hashString(userId) % AVATAR_COLORS.length];
}

/** Texte lisible sur cette couleur : encre du thème clair sur jaune / orange, blanc sinon. */
export function userAvatarInk(color: string): string {
  return LIGHT_COLORS.has(color) ? 'rgb(17 17 20)' : 'var(--rv-on-accent)';
}
