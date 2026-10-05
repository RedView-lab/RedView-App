/**
 * Identifiants des objets et chemins des propriétés du document à plat
 * (cf. objects.ts).
 *
 * Objet racine : `p`. Élément d'une liste : `<parent>/<champ>:<clé>` (un
 * itinéraire : `p/itineraries:it-1` ; une ligne de sa feuille de route :
 * `p/itineraries:it-1/timeline:wp-3`). Les ids se déduisent du document :
 * aucune table de correspondance, et deux éditeurs qui créent le même
 * élément (même clé) désignent le même objet.
 *
 * Chemin de propriété : segments séparés par `.` (`priorities.elevation`).
 * Chaque segment est échappé (`%`, `.`, `/`, `:`) : une clé d'objet peut
 * contenir un point (clé d'alerte pente…) sans ambiguïté.
 */

export const ROOT_OBJECT_ID = 'p';

function escapeSegment(segment: string): string {
  return segment.replace(/[%./:]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

function unescapeSegment(segment: string): string {
  return segment.replace(/%([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function encodePath(segments: readonly string[]): string {
  return segments.map(escapeSegment).join('.');
}

export function decodePath(path: string): string[] {
  return path === '' ? [] : path.split('.').map(unescapeSegment);
}

/** Id de l'élément `key` de la liste `field` (chemin encodé) de l'objet `parentId`. */
export function childObjectId(parentId: string, field: string, key: string): string {
  return `${parentId}/${field}:${escapeSegment(key)}`;
}

/** Clé d'un élément de liste d'après son id. */
export function childKey(objectId: string): string {
  const colon = objectId.lastIndexOf(':');
  return unescapeSegment(objectId.slice(colon + 1));
}

/** Itinéraire contenant un objet (id de l'itinéraire, pas de l'objet), ou null. */
export function itineraryIdOf(objectId: string): string | null {
  const prefix = `${ROOT_OBJECT_ID}/itineraries:`;
  if (!objectId.startsWith(prefix)) return null;
  const rest = objectId.slice(prefix.length);
  const slash = rest.indexOf('/');
  return unescapeSegment(slash < 0 ? rest : rest.slice(0, slash));
}

/** Id de l'objet itinéraire d'un itinéraire. */
export function itineraryObjectId(itineraryId: string): string {
  return childObjectId(ROOT_OBJECT_ID, 'itineraries', itineraryId);
}
