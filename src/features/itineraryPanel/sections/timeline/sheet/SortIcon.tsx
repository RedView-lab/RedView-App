interface SortIconProps {
  direction: 'asc' | 'desc' | null;
}

export function SortIcon({ direction }: SortIconProps) {
  const cls = direction ? `rvi-tl-th__sort is-${direction}` : 'rvi-tl-th__sort';
  return (
    <span className={cls} aria-hidden>
      <svg width="10" height="12" viewBox="0 0 10 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M5 1.5 L5 10.5 M5 1.5 L2 4.5 M5 1.5 L8 4.5 M5 10.5 L2 7.5 M5 10.5 L8 7.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
