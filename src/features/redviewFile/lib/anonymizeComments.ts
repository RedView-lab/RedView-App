/**
 * Commentaires d'un projet exporté en `.redview` : ceux de l'expéditeur
 * restent à son nom ; les autres auteurs (co-éditeurs d'un projet partagé,
 * auteurs d'un fichier importé) deviennent « Éditeur 2 », « Éditeur 3 »…
 * Leur identifiant de compte, leur nom (champs et `@mentions` du texte) et
 * leurs réactions ne partent pas chez un tiers sans leur accord (G2-1).
 * Fonction pure.
 */
import type { ProjectCommentThread } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';

export function anonymizeOtherCommentAuthors(
  threads: readonly ProjectCommentThread[] | undefined,
  keepUserId: string | null,
): ProjectCommentThread[] | undefined {
  if (!threads) return threads;

  const pseudonyms = new Map<string, { id: string; name: string }>();
  const pseudonymOf = (userId: string) => {
    let entry = pseudonyms.get(userId);
    if (!entry) {
      const n = pseudonyms.size + 2;
      entry = { id: `editor-${n}`, name: translateAppText('Éditeur {{n}}', { n }) };
      pseudonyms.set(userId, entry);
    }
    return entry;
  };
  const idOf = (userId: string) => (userId === keepUserId ? userId : pseudonymOf(userId).id);

  // Premier passage : un pseudonyme par auteur, dans l'ordre d'apparition, et
  // les noms connus de chacun (pour les `@Nom` du texte).
  const namesById = new Map<string, Set<string>>();
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.authorId === keepUserId) continue;
      pseudonymOf(message.authorId);
      const names = namesById.get(message.authorId) ?? new Set<string>();
      if (message.authorName.trim()) names.add(message.authorName.trim());
      namesById.set(message.authorId, names);
    }
  }
  const replacements = [...namesById.entries()]
    .flatMap(([userId, names]) => [...names].map((name) => ({ name, pseudonym: pseudonymOf(userId).name })))
    // Les noms les plus longs d'abord : « Jean Dupont » avant « Jean ».
    .sort((a, b) => b.name.length - a.name.length);
  const scrubText = (text: string) =>
    replacements.reduce((current, { name, pseudonym }) => current.split(`@${name}`).join(`@${pseudonym}`), text);

  return threads.map((thread) => ({
    ...thread,
    createdBy: idOf(thread.createdBy),
    ...(thread.resolvedBy ? { resolvedBy: idOf(thread.resolvedBy) } : {}),
    messages: thread.messages.map((message) => {
      const own = message.authorId === keepUserId;
      const reactions = message.reactions
        ? Object.fromEntries(Object.keys(message.reactions).map((key) => {
            const separator = key.lastIndexOf('~');
            return [separator < 0 ? key : `${key.slice(0, separator)}~${idOf(key.slice(separator + 1))}`, true as const];
          }))
        : undefined;
      return {
        ...message,
        authorId: idOf(message.authorId),
        authorName: own ? message.authorName : pseudonymOf(message.authorId).name,
        text: scrubText(message.text),
        ...(message.mentions ? { mentions: message.mentions.map(idOf) } : {}),
        ...(reactions ? { reactions } : {}),
      };
    }),
  }));
}
