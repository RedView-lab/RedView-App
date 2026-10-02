import { useState, type CSSProperties } from 'react';
import { readDocumentAppLocale, useAppI18n } from '../i18n';
import { SvgV2Icon } from './SvgV2Icon';

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
  const url = buildFeedbackUrl();
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface FeedbackTriggerButtonProps {
  variant?: 'floating' | 'inline' | 'header';
  style?: CSSProperties;
  className?: string;
  label?: string;
}

export function FeedbackTriggerButton({
  variant = 'inline',
  style,
  className,
  label,
}: FeedbackTriggerButtonProps) {
  const { t } = useAppI18n();
  const [isHovered, setIsHovered] = useState(false);

  const displayLabel = label || t('Donner un avis');

  const baseStyle: CSSProperties =
    variant === 'floating'
      ? {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 6,
          border: isHovered
            ? '1px solid rgba(255, 255, 255, 0.2)'
            : '1px solid rgba(255, 255, 255, 0.08)',
          background: isHovered
            ? 'rgba(24, 27, 34, 0.88)'
            : 'rgba(16, 18, 24, 0.72)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          color: isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
          fontSize: 'var(--rv-font-size-sm)',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          userSelect: 'none',
          ...style,
        }
      : variant === 'header'
      ? {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          minHeight: 40,
          padding: '8px 18px',
          borderRadius: 6,
          background: isHovered
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(255, 255, 255, 0.04)',
          border: isHovered
            ? '1px solid rgba(255, 255, 255, 0.16)'
            : '1px solid rgba(255, 255, 255, 0.08)',
          color: isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.85)',
          fontSize: 'var(--rv-font-size-lg)',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          userSelect: 'none',
          ...style,
        }
      : {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderRadius: 6,
          border: isHovered
            ? '1px solid rgba(255, 255, 255, 0.2)'
            : '1px solid rgba(255, 255, 255, 0.08)',
          background: isHovered
            ? 'rgba(255, 255, 255, 0.06)'
            : 'rgba(255, 255, 255, 0.02)',
          color: isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
          fontSize: 'var(--rv-font-size-md)',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          userSelect: 'none',
          ...style,
        };

  return (
    <button
      type="button"
      className={className}
      style={baseStyle}
      onClick={openFeedbackPage}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={t('Donner un avis ou signaler un bug')}
      aria-label={t('Donner un avis ou signaler un bug')}
    >
      <SvgV2Icon
        name="annotation.svg"
        size={variant === 'floating' ? 14 : 16}
        style={{ opacity: isHovered ? 1 : 0.75 }}
      />
      <span>{displayLabel}</span>
    </button>
  );
}
