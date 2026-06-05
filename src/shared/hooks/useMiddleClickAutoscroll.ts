import { useEffect, useRef, useState } from 'react';

const DEAD_ZONE_PX = 10;
const SCROLL_SPEED = 0.35;

export function useMiddleClickAutoscroll<T extends HTMLElement>() {
  const scrollRef = useRef<T | null>(null);
  const activeScrollNodeRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0 });
  const anchorRef = useRef({ x: 0, y: 0 });
  const [isAutoscrolling, setIsAutoscrolling] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const stop = () => {
      activeRef.current = false;
      activeScrollNodeRef.current = null;
      setIsAutoscrolling(false);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mousedown', handleDocumentMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', stop);
    };

    const tick = () => {
      if (!activeRef.current) return;

      const scrollNode = activeScrollNodeRef.current ?? node;

      const deltaX = pointerRef.current.x - anchorRef.current.x;
      const deltaY = pointerRef.current.y - anchorRef.current.y;

      const scrollX =
        Math.abs(deltaX) <= DEAD_ZONE_PX
          ? 0
          : (deltaX - Math.sign(deltaX) * DEAD_ZONE_PX) * SCROLL_SPEED;
      const scrollY =
        Math.abs(deltaY) <= DEAD_ZONE_PX
          ? 0
          : (deltaY - Math.sign(deltaY) * DEAD_ZONE_PX) * SCROLL_SPEED;

      if (scrollX !== 0) scrollNode.scrollLeft += scrollX;
      if (scrollY !== 0) scrollNode.scrollTop += scrollY;

      frameRef.current = window.requestAnimationFrame(tick);
    };

    const start = (clientX: number, clientY: number, scrollNode: HTMLElement) => {
      activeRef.current = true;
      activeScrollNodeRef.current = scrollNode;
      anchorRef.current = { x: clientX, y: clientY };
      pointerRef.current = { x: clientX, y: clientY };
      setIsAutoscrolling(true);
      document.addEventListener('mousemove', handleMouseMove, true);
      document.addEventListener('mousedown', handleDocumentMouseDown, true);
      document.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('blur', stop);
      frameRef.current = window.requestAnimationFrame(tick);
    };

    function handleMouseMove(event: MouseEvent) {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    }

    function handleDocumentMouseDown(event: MouseEvent) {
      if (!activeRef.current) return;
      event.preventDefault();
      stop();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
      }
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (activeRef.current) {
        stop();
        return;
      }
      start(event.clientX, event.clientY, resolveScrollableNode(event.target, node));
    };

    const handleAuxClick = (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    };

    node.addEventListener('mousedown', handleMouseDown);
    node.addEventListener('auxclick', handleAuxClick);

    return () => {
      stop();
      node.removeEventListener('mousedown', handleMouseDown);
      node.removeEventListener('auxclick', handleAuxClick);
    };
  }, []);

  return { scrollRef, isAutoscrolling };
}

function resolveScrollableNode(target: EventTarget | null, fallback: HTMLElement): HTMLElement {
  const root = fallback;
  let current = target instanceof HTMLElement ? target : fallback;

  while (current) {
    if (isScrollable(current)) return current;
    if (current === root) break;
    current = current.parentElement ?? root;
  }

  return fallback;
}

function isScrollable(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node);
  const canScrollY =
    /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
  const canScrollX =
    /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
  return canScrollX || canScrollY;
}