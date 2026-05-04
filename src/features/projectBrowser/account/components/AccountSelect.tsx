import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

export type AccountSelectOption = {
  value: string;
  label: string;
  flag?: string;
  flagCode?: string;
};

type AccountSelectProps = {
  value: string;
  options: readonly AccountSelectOption[];
  onChange: (nextValue: string) => void;
  renderValuePrefix?: (option: AccountSelectOption | undefined) => ReactNode;
  renderOptionPrefix?: (option: AccountSelectOption) => ReactNode;
};

export function AccountSelect({
  value,
  options,
  onChange,
  renderValuePrefix,
  renderOptionPrefix,
}: AccountSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`rvpb-account-select${isOpen ? ' is-open' : ''}`}>
      <button
        type="button"
        className="rvpb-account-select-trigger rvpb-account-select-shell"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onClick={() => setIsOpen((previous) => !previous)}
      >
        {renderValuePrefix ? renderValuePrefix(selectedOption) : null}
        <span className="rvpb-account-select-value">{selectedOption?.label ?? value}</span>
        <span className="rvpb-account-select-icon" aria-hidden="true">
          <SvgV2Icon name="chevron-down.svg" size={16} />
        </span>
      </button>

      {isOpen ? (
        <div id={listboxId} className="rvpb-account-select-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`rvpb-account-select-option${isSelected ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                {renderOptionPrefix ? renderOptionPrefix(option) : null}
                <span className="rvpb-account-select-option-label">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}