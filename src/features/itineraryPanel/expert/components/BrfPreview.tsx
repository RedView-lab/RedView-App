/**
 * Read-only preview of the BRF profile generated from the current
 * Expert Mode state. The user can copy/paste it into BRouter-Web for
 * advanced experiments, or upload it through the panel ("Téléverser").
 */
import { useMemo, useState } from 'react';
import type { ExpertProfileState } from '../types';
import { generateBrfFromExpertState } from '../../lib/brouter/profiles/profile-template';

interface BrfPreviewProps {
  state: ExpertProfileState;
}

export function BrfPreview({ state }: BrfPreviewProps) {
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
        <h4 className="rvi-expert-preview__title">Profil BRF généré</h4>
        <button
          type="button"
          className="rvi-expert-preview__copy"
          onClick={handleCopy}
        >
          {copied ? 'Copié ✓' : 'Copier'}
        </button>
      </div>
      <pre className="rvi-expert-preview__code">
        <code>{brf}</code>
      </pre>
      <p className="rvi-expert-preview__hint">
        Compatible avec{' '}
        <a
          href="https://brouter.de/brouter-web"
          target="_blank"
          rel="noopener noreferrer"
        >
          BRouter-Web
        </a>{' '}
        pour des tests avancés. Ce code est généré localement, dans votre
        navigateur uniquement.
      </p>
    </div>
  );
}
