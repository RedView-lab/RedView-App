import { act, createElement, StrictMode, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * `renderHook` minimal pour Vitest sans @testing-library : monte le hook dans
 * une vraie racine React DOM. Le fichier de test a besoin d'un DOM : le faire
 * commencer par `// @vitest-environment happy-dom`.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export interface RenderedHook<Props, Result> {
  /** Valeur renvoyée par le dernier rendu validé. */
  readonly result: { current: Result };
  rerender(props: Props): void;
  unmount(): void;
}

export interface RenderHookOptions<Props> {
  initialProps: Props;
  strict?: boolean;
  /** Providers autour du hook ; ils reçoivent les mêmes props que le hook. */
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
