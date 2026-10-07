import { useEffect, useState, type ReactNode } from 'react';

/**
 * Smoothly collapses / expands its children using the modern
 * `grid-template-rows: 0fr → 1fr` technique. No JS height-measuring,
 * works for variable content heights, plays well with auto-layout.
 *
 * Visuals:
 *  - opacity fades 0 ↔ 1 (180 ms, ease-out)
 *  - height grows from 0 to natural height (220 ms, cubic-bezier)
 *  - children are kept mounted while the closing animation runs, then
 *    unmounted to avoid stale focus / tab-order inside a 0-height block.
 */
interface CollapseProps {
  open: boolean;
  /** Optional outer className applied to the wrapper. */
  className?: string;
  /** Animation duration in ms (default 220). */
  duration?: number;
  children: ReactNode;
}

export function Collapse({
  open,
  className,
  duration = 220,
  children,
}: CollapseProps) {
  // Keep children mounted during the close animation. We unmount only
  // once the wrapper has fully collapsed.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setMounted(false), duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);

  return (
    <div
      className={`rvi-collapse${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      style={{ ['--rvi-collapse-duration' as never]: `${duration}ms` }}
      aria-hidden={!open}
    >
      <div className="rvi-collapse__inner">
        {mounted ? children : null}
      </div>
    </div>
  );
}
