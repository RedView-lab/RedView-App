/**
 * Anciennes URL des fichiers de public/, servies sous leur nouvelle adresse.
 *
 * Le rangement de public/ du 2026-10-08 (e1f879b : svgv2/icone → icons/ui,
 * svgv2/poi → icons/poi, right-click-icons → icons/context-menu, landing/svg →
 * flags, landing/icons → brand, project-browser/settings → images/settings)
 * a fait passer en 404 les URL que demande encore un onglet ouvert avant le
 * déploiement (ou l'app « ajoutée au Dock » de Safari) : son JS est l'ancien
 * build, et chaque icône pas encore en cache — masques CSS, sprites des POI de
 * la carte, menu du clic droit — disparaissait sans erreur visible.
 *
 * Le serveur résout donc ces préfixes vers le nouveau fichier (réécriture
 * interne, pas de redirection : un masque CSS ou une image chargée par Mapbox
 * n'a pas d'aller-retour de plus). Un futur déplacement de fichiers de public/
 * ajoute ses préfixes ici.
 */

/** @type {ReadonlyArray<readonly [string, string]>} ancien préfixe → nouveau préfixe */
const LEGACY_PREFIXES = [
  ['/svgv2/icone/', '/icons/ui/'],
  ['/svgv2/poi/', '/icons/poi/'],
  ['/right-click-icons/', '/icons/context-menu/'],
  ['/landing/svg/', '/flags/'],
  ['/landing/icons/', '/brand/'],
  ['/project-browser/settings/', '/images/settings/'],
];

/** @type {ReadonlyMap<string, string>} ancien chemin exact → nouveau chemin */
const LEGACY_FILES = new Map([
  ['/multiPOI.svg', '/icons/poi/multiPOI.svg'],
]);

/**
 * Nouveau chemin d'un fichier de public/ déplacé, ou `null` (chemin inchangé).
 * `pathname` est déjà décodé et normalisé (pas de `..`) par l'appelant.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function resolveLegacyAssetPath(pathname) {
  const file = LEGACY_FILES.get(pathname);
  if (file) return file;
  for (const [from, to] of LEGACY_PREFIXES) {
    if (pathname.startsWith(from) && pathname.length > from.length) return to + pathname.slice(from.length);
  }
  return null;
}
