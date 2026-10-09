/**
 * Liens dans le texte des pages légales : `[libellé](https://…)`,
 * `[libellé](mailto:…)` ou `[libellé](/chemin)`. Toute autre cible reste du
 * texte : le contenu est écrit dans le dépôt, mais rien d'autre qu'un lien sûr
 * ne doit pouvoir devenir un élément.
 */

export type InlineSegment = { text: string } | { text: string; href: string };

const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function isSafeHref(href: string): boolean {
  return /^https:\/\//.test(href) || /^mailto:[^\s@]+@[^\s@]+$/.test(href) || /^\/[\w\-/]*$/.test(href);
}

export function parseInlineLinks(source: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of source.matchAll(LINK_PATTERN)) {
    const [whole, label, href] = match;
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: source.slice(last, start) });
    segments.push(isSafeHref(href) ? { text: label, href } : { text: whole });
    last = start + whole.length;
  }
  if (last < source.length) segments.push({ text: source.slice(last) });
  return segments;
}
