import { useState, type ReactNode } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { IconRepeat } from '../icons';

interface ActionButtonStackProps {
  primaryLabel: string;
  /** Icône de l'état initial (défaut : flèches de recalcul). */
  primaryIcon?: ReactNode;
  onPrimaryClick?: () => void;
  primaryDisabled?: boolean;
  loadingLabel?: string | null;
  onLoadingClick?: () => void;
  resultLabel?: string | null;
  onResultClick?: () => void;
}

export function ActionButtonStack({
  primaryLabel,
  primaryIcon,
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
  let buttonIcon: ReactNode = primaryIcon ?? <IconRepeat size={16} />;
  let buttonClick = onPrimaryClick;
  let buttonDisabled = primaryDisabled;
  let buttonClassName = 'rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--primary';

  if (isLoadingState) {
    buttonLabel = loadingHovered && loadingIsCancelable ? t('Interrompre') : loadingLabel!;
    buttonClick = onLoadingClick;
    buttonDisabled = !loadingIsCancelable;
    buttonIcon = <IconRepeat size={16} />;
    buttonClassName = 'rvi-redbtn rvi-redbtn--full rvi-action-stack__button rvi-action-stack__button--secondary is-loading';
  } else if (isResultState) {
    buttonLabel = resultLabel!;
    buttonClick = resultClickHandler;
    buttonDisabled = typeof resultClickHandler !== 'function';
    buttonIcon = <IconRepeat size={16} />;
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
        aria-busy={isLoadingState || undefined}
      >
        <span className="rvi-action-stack__icon">{buttonIcon}</span>
        <span className="rvi-action-stack__label">{buttonLabel}</span>
      </button>
    </div>
  );
}