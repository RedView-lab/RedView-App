import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { readDocumentAppLocale } from '../i18n';

export function buildFeedbackUrl(): string {
  const landingUrl =
    (import.meta.env.VITE_LANDING_URL as string | undefined) || 'https://redview.tech';
  const base = `${landingUrl.replace(/\/$/, '')}/`;
  const params = new URLSearchParams();
  params.set('feedback', 'open');
  params.set('step', '1');
  // No PII in the URL (it leaks into history, server logs, analytics and
  // Referer): only non-identifying context is passed to the feedback form.
  params.set('source', 'app');
  params.set('lang', readDocumentAppLocale());

  return `${base}?${params.toString()}`;
}

export function openFeedbackPage() {
  trackAnalyticsEvent({ name: 'feedback_opened' });
  const url = buildFeedbackUrl();
  window.open(url, '_blank', 'noopener,noreferrer');
}
