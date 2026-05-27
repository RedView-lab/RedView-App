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
  const hasLoadingLabel = typeof loadingLabel === 'string' && loadingLabel.trim().length > 0;
  const hasResultLabel = typeof resultLabel === 'string' && resultLabel.trim().length > 0;
  const loadingIsCancelable = typeof onLoadingClick === 'function';
  const resultClickHandler = onResultClick ?? onPrimaryClick;
  const isLoadingState = hasLoadingLabel;
  const isResultState = !isLoadingState && hasResultLabel;

  let buttonLabel = primaryLabel;
  let buttonClick = onPrimaryClick;
  let buttonDisabled = primaryDisabled;
  let buttonClassName = 'rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--primary';

  if (isLoadingState) {
    buttonLabel = loadingHovered && loadingIsCancelable ? t('Interrompre') : loadingLabel!;
    buttonClick = onLoadingClick;
    buttonDisabled = !loadingIsCancelable;
    buttonClassName = 'rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--secondary';
  } else if (isResultState) {
    buttonLabel = resultLabel!;
    buttonClick = resultClickHandler;
    buttonDisabled = typeof resultClickHandler !== 'function';
    buttonClassName = 'rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--secondary';
  }

  return (
    <div className="rvi-action-stack">
      <button
        type="button"
        className={buttonClassName}
        onClick={buttonClick}
        onMouseEnter={() => {
          if (isLoadingState) setLoadingHovered(true);
        }}
        onMouseLeave={() => {
          if (isLoadingState) setLoadingHovered(false);
        }}
        disabled={buttonDisabled}
      >
        <IconRepeat size={16} />
        <span>{buttonLabel}</span>
      </button>
    </div>
  );
}