import { useState, type ReactNode } from 'react';

interface MenuActionRowProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

export function MenuActionRow({ label, icon, onClick }: MenuActionRowProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        width: '100%',
        minWidth: 80,
        padding: 4,
        border: 'none',
        background: isHovered ? 'rgba(255,255,255,0.06)' : 'transparent',
        borderRadius: 6,
        cursor: 'pointer',
        textAlign: 'left',
        color: '#ffffff',
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
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 'normal',
        }}
      >
        {label}
      </span>
    </button>
  );
}