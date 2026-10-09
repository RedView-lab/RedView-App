import type { ProjectCommentMessage } from '@/features/itineraryPanel/types';
import type { AppTranslationVars } from '@/shared/i18n';

/** Extrait du message repris dans le signalement (un `mailto:` reste court). */
const EXCERPT_MAX_CHARS = 500;

type Translate = (text: string, vars?: AppTranslationVars) => string;

/**
 * Lien `mailto:` de signalement d'un commentaire (DSA art. 16 : moyen
 * électronique et facile d'accès de signaler un contenu illicite ; CGU § 5) :
 * l'adresse de contact, l'auteur, la date, l'identifiant du message pour le
 * retrouver, un extrait, et la raison laissée à la personne qui signale.
 */
export function buildCommentReportHref(
  contactEmail: string,
  message: Pick<ProjectCommentMessage, 'id' | 'text' | 'createdAt'>,
  authorName: string,
  t: Translate,
): string {
  const text = message.text.replace(/\s+/g, ' ').trim();
  const excerpt = text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS)}…` : text;
  const body = [
    t('Je signale ce commentaire comme illicite.'),
    '',
    t('Auteur : {{name}}', { name: authorName }),
    t('Date : {{date}}', { date: message.createdAt }),
    t('Identifiant du message : {{id}}', { id: message.id }),
    t('Texte : « {{text}} »', { text: excerpt }),
    '',
    t('Raison du signalement :'),
    '',
  ].join('\n');
  const subject = t('Signalement d’un commentaire RedView');
  return `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
