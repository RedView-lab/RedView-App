import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Minimal `renderHook` for Vitest without @testing-library: mounts the hook in
 * a real React DOM root. The test file needs a DOM: start it with
 * `// @vitest-environment happy-dom`.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export interface RenderedHook<Props, Result> {
  /** Value returned by the last committed render. */
  readonly result: { current: Result };
  rerender(props: Props): void;
  unmount(): void;
}

export function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  options: { initialProps: Props; strict?: boolean },
): RenderedHook<Props, Result> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const result = { current: undefined as Result };
  const container = document.createElement('div');
  let root: Root | null = createRoot(container);

  function Probe({ props }: { props: Props }) {
    result.current = hook(props);
    return null;
  }
  const render = (props: Props) => {
    const probe = createElement(Probe, { props });
    act(() => root?.render(options.strict ? createElement(StrictMode, null, probe) : probe));
  };

  render(options.initialProps);
  return {
    result,
    rerender: render,
    unmount: () => {
      act(() => root?.unmount());
      root = null;
    },
  };
}
