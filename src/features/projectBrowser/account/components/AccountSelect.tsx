import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

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
  ariaLabel?: string;
  renderValuePrefix?: (option: AccountSelectOption | undefined) => ReactNode;
  renderOptionPrefix?: (option: AccountSelectOption) => ReactNode;
};

export function AccountSelect({
  value,
  options,
  onChange,
  ariaLabel,
  renderValuePrefix,
  renderOptionPrefix,
}: AccountSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );
  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((option) => option.value === value)),
    [options, value],
  );

  const focusOptionAt = useCallback(
    (index: number) => {
      const nextIndex = Math.min(Math.max(index, 0), options.length - 1);
      optionRefs.current[nextIndex]?.focus();
    },
    [options.length],
  );

  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = (targetIndex = selectedIndex) => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      focusOptionAt(targetIndex);
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    requestAnimationFrame(() => {
      focusOptionAt(selectedIndex);
    });
  }, [focusOptionAt, isOpen, selectedIndex]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        openMenu(selectedIndex);
        break;
      case 'ArrowUp':
        event.preventDefault();
        openMenu(selectedIndex > 0 ? selectedIndex : options.length - 1);
        break;
      default:
        break;
    }
  };

  const handleOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    option: AccountSelectOption,
    index: number,
  ) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusOptionAt(index + 1 >= options.length ? 0 : index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusOptionAt(index - 1 < 0 ? options.length - 1 : index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusOptionAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusOptionAt(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onChange(option.value);
        closeMenu();
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu();
        break;
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className={`rvpb-account-select${isOpen ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="rvpb-account-select-trigger rvpb-account-select-shell"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
            return;
          }

          openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        {renderValuePrefix ? renderValuePrefix(selectedOption) : null}
        <span className="rvpb-account-select-value">{selectedOption?.label ?? value}</span>
        <span className="rvpb-account-select-icon" aria-hidden="true">
          <SvgV2Icon name="chevron-down.svg" size={20} />
        </span>
      </button>

      {isOpen ? (
        <div id={listboxId} className="rvpb-account-select-menu" role="listbox">
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const optionId = `${listboxId}-${option.value}`;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                id={optionId}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                className={`rvpb-account-select-option${isSelected ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange(option.value);
                  closeMenu();
                }}
                onKeyDown={(event) => handleOptionKeyDown(event, option, index)}
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