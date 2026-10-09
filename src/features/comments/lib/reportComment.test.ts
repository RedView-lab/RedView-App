import { describe, expect, it } from 'vitest';

import { buildCommentReportHref } from './reportComment';

const t = (text: string, vars?: Record<string, string | number>) =>
  text.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => String(vars?.[key] ?? ''));

describe('buildCommentReportHref', () => {
  it('prépare un e-mail de signalement : auteur, date, identifiant, extrait, raison à compléter', () => {
    const href = buildCommentReportHref(
      'contact@example.test',
      { id: 'msg_42', text: 'Texte\n  à   signaler', createdAt: '2026-10-09T10:00:00.000Z' },
      'Ada',
      t,
    );
    const url = new URL(href);
    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('contact@example.test');
    expect(url.searchParams.get('subject')).toBe('Signalement d’un commentaire RedView');
    expect(url.searchParams.get('body')).toBe([
      'Je signale ce commentaire comme illicite.',
      '',
      'Auteur : Ada',
      'Date : 2026-10-09T10:00:00.000Z',
      'Identifiant du message : msg_42',
      'Texte : « Texte à signaler »',
      '',
      'Raison du signalement :',
      '',
    ].join('\n'));
  });

  it('coupe un long message pour garder un lien mailto court', () => {
    const href = buildCommentReportHref('c@example.test', { id: 'm', text: 'x'.repeat(5000), createdAt: '' }, 'B', t);
    const body = new URL(href).searchParams.get('body') ?? '';
    expect(body).toContain(`« ${'x'.repeat(500)}… »`);
    expect(href.length).toBeLessThan(2000);
  });
});
