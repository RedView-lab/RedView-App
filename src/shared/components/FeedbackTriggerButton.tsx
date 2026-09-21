import { useState, type CSSProperties } from 'react';
import { readStoredAppwriteSession } from '../services/appwrite';
import { useAppI18n } from '../i18n';

export function buildFeedbackUrl(): string {
  const landingUrl =
    (import.meta.env.VITE_LANDING_URL as string | undefined) || 'https://redview.tech';
  const base = `${landingUrl.replace(/\/$/, '')}/`;
  const params = new URLSearchParams();
  params.set('feedback', 'open');
  params.set('step', '1');

  try {
    const sessionUser = readStoredAppwriteSession()?.user;
    if (sessionUser?.email) params.set('email', sessionUser.email);
    if (sessionUser?.name) {
      const parts = sessionUser.name.trim().split(' ');
      params.set('firstName', parts[0] || '');
      if (parts.length > 1) {
        params.set('lastName', parts.slice(1).join(' '));
      }
    }
  } catch {
    // Ignore if session not available
  }

  return `${base}?${params.toString()}`;
}

export function openFeedbackPage() {
  const url = buildFeedbackUrl();
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface FeedbackTriggerButtonProps {
  variant?: 'floating' | 'inline';
  style?: CSSProperties;
  className?: string;
}

export function FeedbackTriggerButton({
  variant = 'floating',
  style,
  className,
}: FeedbackTriggerButtonProps) {
  const { t } = useAppI18n();
  const [isHovered, setIsHovered] = useState(false);

  const baseStyle: CSSProperties =
    variant === 'floating'
      ? {
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 9999,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderRadius: 999,
          border: isHovered
            ? '1px solid rgba(255, 255, 255, 0.28)'
            : '1px solid rgba(255, 255, 255, 0.12)',
          background: isHovered
            ? 'rgba(28, 28, 34, 0.95)'
            : 'rgba(18, 18, 22, 0.82)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 500,
          boxShadow: isHovered
            ? '0 6px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)'
            : '0 4px 16px rgba(0, 0, 0, 0.35)',
          cursor: 'pointer',
          transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          transform: isHovered ? 'translateY(-2px)' : 'none',
          textDecoration: 'none',
          userSelect: 'none',
          ...style,
        }
      : {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderRadius: 8,
          border: isHovered
            ? '1px solid rgba(255, 255, 255, 0.25)'
            : '1px solid rgba(255, 255, 255, 0.1)',
          background: isHovered
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(255, 255, 255, 0.04)',
          color: '#e5e7eb',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          textDecoration: 'none',
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
      title={t('Partagez un avis, une idée ou signalez un bug')}
      aria-label={t('Donner un avis ou signaler un bug')}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#10b981',
          boxShadow: '0 0 8px #10b981',
          flexShrink: 0,
        }}
      />
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span>{t('Donner un avis / Signaler un bug')}</span>
    </button>
  );
}
