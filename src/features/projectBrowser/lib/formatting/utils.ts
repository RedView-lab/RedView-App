import type { ProjectSummary } from '@/shared/utils/projects';
import { readDocumentAppLocale, translateAppText } from '@/shared/i18n';

export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const locale = readDocumentAppLocale();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return locale === 'fr' ? `${dd}/${mm}/${yy} à ${hh}:${mn}` : `${mm}/${dd}/${yyyy} at ${hh}:${mn}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const locale = readDocumentAppLocale();
  if (bytes < 1024) return locale === 'fr' ? `${bytes}o` : `${bytes} B`;
  if (bytes < 1024 * 1024) return locale === 'fr' ? `${Math.round(bytes / 1024)}ko` : `${Math.round(bytes / 1024)} KB`;
  return locale === 'fr' ? `${Math.round(bytes / (1024 * 1024))}mo` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function privacyLabel(privacy: ProjectSummary['privacy']): string {
  return privacy === 'public' ? translateAppText('Public') : translateAppText('Privé');
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const locale = readDocumentAppLocale();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const yyyy = String(d.getFullYear());
  return locale === 'fr' ? `${dd}/${mm}/${yy}` : `${mm}/${dd}/${yyyy}`;
}