import { useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconRepeat } from '../icons';

interface ActionButtonStackProps {
  primaryLabel: string;
  onPrimaryClick?: () => void;
  primaryDisabled?: boolean;
  loadingLabel?: string | null;
  onLoadingClick?: () => void;
  resultLabel?: string | null;
  onResultClick?: () => void;
}

export function ActionButtonStack({
  primaryLabel,
  onPrimaryClick,
  primaryDisabled = false,
  loadingLabel = null,
  onLoadingClick,
  resultLabel = null,
  onResultClick,
}: ActionButtonStackProps) {
  const { t } = useAppI18n();
  const [loadingHovered, setLoadingHovered] = useState(false);
  const showLoadingButton = typeof loadingLabel === 'string' && loadingLabel.trim().length > 0;
  const showResultButton = typeof resultLabel === 'string' && resultLabel.trim().length > 0;
  const loadingIsCancelable = typeof onLoadingClick === 'function';
  const resultClickHandler = onResultClick ?? onPrimaryClick;

  return (
    <div className="rvi-action-stack">
      <button
        type="button"
        className="rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--primary"
        onClick={onPrimaryClick}
        disabled={primaryDisabled}
      >
        <IconRepeat size={16} />
        <span>{primaryLabel}</span>
      </button>

      {showLoadingButton ? (
        <button
          type="button"
          className="rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--secondary"
          onClick={onLoadingClick}
          onMouseEnter={() => setLoadingHovered(true)}
          onMouseLeave={() => setLoadingHovered(false)}
          disabled={!loadingIsCancelable}
        >
          <IconRepeat size={16} />
          <span>{loadingHovered && loadingIsCancelable ? t('Interrompre') : loadingLabel}</span>
        </button>
      ) : null}

      {showResultButton ? (
        <button
          type="button"
          className="rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--secondary"
          onClick={resultClickHandler}
          disabled={typeof resultClickHandler !== 'function'}
        >
          <IconRepeat size={16} />
          <span>{resultLabel}</span>
        </button>
      ) : null}
    </div>
  );
}