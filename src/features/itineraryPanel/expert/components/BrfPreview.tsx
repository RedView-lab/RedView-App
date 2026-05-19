/**
 * Read-only preview of the BRF profile generated from the current
 * Expert Mode state. The user can copy/paste it into BRouter-Web for
 * advanced experiments, or upload it through the panel ("Téléverser").
 */
import { useMemo, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { ExpertProfileState } from '../types';
import { generateBrfFromExpertState } from '../../lib/brouter/profiles/profile-template';

interface BrfPreviewProps {
  state: ExpertProfileState;
}

export function BrfPreview({ state }: BrfPreviewProps) {
  const { t } = useAppI18n();
  const brf = useMemo(() => generateBrfFromExpertState(state), [state]);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(brf);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop — clipboard may be blocked */
    }
  };

  return (
    <div className="rvi-expert-preview">
      <div className="rvi-expert-preview__head">
        <h4 className="rvi-expert-preview__title">{t('Profil BRF généré')}</h4>
        <button
          type="button"
          className="rvi-expert-preview__copy"
          onClick={handleCopy}
        >
          {copied ? t('Copié ✓') : t('Copier')}
        </button>
      </div>
      <pre className="rvi-expert-preview__code">
        <code>{brf}</code>
      </pre>
      <p className="rvi-expert-preview__hint">
        {t('Compatible avec')}{' '}
        <a
          href="https://brouter.de/brouter-web"
          target="_blank"
          rel="noopener noreferrer"
        >
          BRouter-Web
        </a>{' '}
        {t('pour des tests avancés. Ce code est généré localement, dans votre navigateur uniquement.')}
      </p>
    </div>
  );
}
