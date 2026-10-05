import { describe, expect, it } from 'vitest';

import { activeMentionQuery, extractMentions, filterMentionCandidates, insertMention, tokenizeMessage } from './messageText';

const members = [
  { userId: 'u-1', name: 'Victor' },
  { userId: 'u-2', name: 'Victor Hugo' },
  { userId: 'u-3', name: 'Simon' },
];

describe('texte des messages', () => {
  it('découpe mentions et liens, le nom le plus long gagne', () => {
    const tokens = tokenizeMessage('@Victor Hugo regarde https://redview.tech/a?b=1. Merci @Simon', members);
    expect(tokens).toEqual([
      { kind: 'mention', text: '@Victor Hugo', userId: 'u-2' },
      { kind: 'text', text: ' regarde ' },
      { kind: 'link', text: 'https://redview.tech/a?b=1', href: 'https://redview.tech/a?b=1' },
      { kind: 'text', text: '. Merci ' },
      { kind: 'mention', text: '@Simon', userId: 'u-3' },
    ]);
  });

  it('pas de mention au milieu d’un mot, jamais de lien hors http(s)', () => {
    expect(tokenizeMessage('mail@Simon.fr javascript:alert(1)', members)).toEqual([
      { kind: 'text', text: 'mail@Simon.fr javascript:alert(1)' },
    ]);
  });

  it('extrait les membres mentionnés', () => {
    expect(extractMentions('salut @Simon et @Victor !', members)).toEqual(['u-1', 'u-3']);
    expect(extractMentions('salut Simon', members)).toEqual([]);
  });

  it('saisie d’une mention : requête, filtre, insertion', () => {
    expect(activeMentionQuery('Bonjour @Vic', 12)).toEqual({ start: 8, query: 'Vic' });
    expect(activeMentionQuery('mail@Vic', 8)).toBeNull();
    expect(activeMentionQuery('@a\nb', 4)).toBeNull();
    expect(filterMentionCandidates(members, 'hu').map((member) => member.userId)).toEqual(['u-2']);
    expect(filterMentionCandidates(members, 'vic').map((member) => member.userId)).toEqual(['u-1', 'u-2']);
    expect(insertMention('Bonjour @Vic!', 8, 12, 'Victor')).toEqual({ text: 'Bonjour @Victor !', caret: 16 });
  });
});
