import { act, createElement, StrictMode, type ComponentType, type ReactNode } from 'react';
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

export interface RenderHookOptions<Props> {
  initialProps: Props;
  strict?: boolean;
  /** Providers around the hook; they get the same props as the hook. */
  wrapper?: ComponentType<{ children: ReactNode; props: Props }>;
}

export function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  options: RenderHookOptions<Props>,
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
    let tree: ReactNode = createElement(Probe, { props });
    if (options.wrapper) tree = createElement(options.wrapper, { props, children: tree });
    if (options.strict) tree = createElement(StrictMode, null, tree);
    act(() => root?.render(tree));
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
