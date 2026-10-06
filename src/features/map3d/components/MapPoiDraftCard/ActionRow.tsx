import { useState } from 'react';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

export function DeleteGlyph() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        color: 'var(--rv-text)',
      }}
    >
      <SvgV2Icon name="trash-03.svg" size={16} />
    </span>
  );
}

interface ActionRowProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export function ActionRow({
  label,
  icon,
  onClick,
}: ActionRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        minWidth: 80,
        minHeight: 32,
        padding: 4,
        border: 'none',
        borderRadius: 6,
        background: hovered ? 'rgb(var(--rv-ink) / 0.06)' : 'transparent',
        cursor: 'pointer',
        color: 'var(--rv-text)',
        textAlign: 'left',
        pointerEvents: 'auto',
      }}
    >
      {icon}
      <span
        style={{
          minWidth: 0,
          flex: '1 1 0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--rv-font-size-md)',
          fontWeight: 600,
          lineHeight: '17px',
          color: 'var(--rv-text)',
        }}
      >
        {label}
      </span>
    </button>
  );
}
