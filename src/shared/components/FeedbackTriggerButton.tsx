import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { readDocumentAppLocale } from '../i18n';

function buildFeedbackUrl(): string {
  const landingUrl =
    (import.meta.env.VITE_LANDING_URL as string | undefined) || 'https://redview.tech';
  const base = `${landingUrl.replace(/\/$/, '')}/`;
  const params = new URLSearchParams();
  params.set('feedback', 'open');
  params.set('step', '1');
  // Pas de donnée personnelle dans l'URL (elle fuit dans l'historique, les
  // journaux serveur, les statistiques et le Referer) : seul un contexte non
  // identifiant est transmis au formulaire d'avis.
  params.set('source', 'app');
  params.set('lang', readDocumentAppLocale());

  return `${base}?${params.toString()}`;
}

export function openFeedbackPage() {
  trackAnalyticsEvent({ name: 'feedback_opened' });
  const url = buildFeedbackUrl();
  window.open(url, '_blank', 'noopener,noreferrer');
}
