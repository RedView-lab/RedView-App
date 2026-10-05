/**
 * Texte d'un message : mentions `@Nom` (membres du projet) et liens http(s).
 * Le texte reste brut : l'affichage le découpe en jetons rendus par React
 * (jamais de HTML), un lien n'est jamais qu'en http(s).
 */

export interface MentionCandidate {
  userId: string;
  name: string;
}

export type MessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string }
  | { kind: 'link'; text: string; href: string };

const LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
/** Ponctuation de fin de phrase collée à un lien : hors du lien. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»"']+$/;

function splitLinks(text: string): MessageToken[] {
  const tokens: MessageToken[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let raw = match[0];
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    if (trailing) raw = raw.slice(0, raw.length - trailing.length);
    if (raw.length <= 'https://'.length) continue;
    let href: string | null = null;
    try {
      const url = new URL(raw);
      href = url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > last) tokens.push({ kind: 'text', text: text.slice(last, start) });
    tokens.push({ kind: 'link', text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) });
  return tokens;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/** Mentions de `candidates` dans un fragment de texte (noms les plus longs d'abord). */
function splitMentions(text: string, candidates: readonly MentionCandidate[]): MessageToken[] {
  if (candidates.length === 0 || !text.includes('@')) return [{ kind: 'text', text }];
  const sorted = [...candidates].filter((candidate) => candidate.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const tokens: MessageToken[] = [];
  let buffer = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === '@' && !isWordChar(text[index - 1])) {
      const rest = text.slice(index + 1);
      const match = sorted.find((candidate) => rest.startsWith(candidate.name) && !isWordChar(rest[candidate.name.length]));
      if (match) {
        if (buffer) tokens.push({ kind: 'text', text: buffer });
        buffer = '';
        tokens.push({ kind: 'mention', text: `@${match.name}`, userId: match.userId });
        index += 1 + match.name.length;
        continue;
      }
    }
    buffer += text[index];
    index += 1;
  }
  if (buffer) tokens.push({ kind: 'text', text: buffer });
  return tokens;
}

/** Jetons d'affichage d'un message (`mentioned` : les membres mentionnés du message). */
export function tokenizeMessage(text: string, mentioned: readonly MentionCandidate[]): MessageToken[] {
  return splitLinks(text).flatMap((token) => (token.kind === 'text' ? splitMentions(token.text, mentioned) : [token]));
}

/** Membres mentionnés dans `text` (dans l'ordre de `candidates`). */
export function extractMentions(text: string, candidates: readonly MentionCandidate[]): string[] {
  const found = new Set<string>();
  for (const token of splitMentions(text, candidates)) {
    if (token.kind === 'mention') found.add(token.userId);
  }
  return candidates.filter((candidate) => found.has(candidate.userId)).map((candidate) => candidate.userId);
}

/** Mention en cours de saisie juste avant le curseur (`@que`), ou null. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || isWordChar(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/** Membres dont le nom commence par (ou contient) la saisie. */
export function filterMentionCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...candidates];
  const starts = candidates.filter((candidate) => candidate.name.toLocaleLowerCase().startsWith(needle));
  const contains = candidates.filter((candidate) => !starts.includes(candidate) && candidate.name.toLocaleLowerCase().includes(needle));
  return [...starts, ...contains];
}

/** Remplace la saisie `@que` (de `start` au curseur) par la mention complète. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`, caret: start + inserted.length };
}
