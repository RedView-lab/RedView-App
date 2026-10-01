import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  createAppTranslationBundle,
  interpolateAppTranslation,
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationBundle,
  type AppTranslationVars,
} from './config';

type AppI18nContextValue = {
  locale: AppLocale;
  setLocale: (nextLocale: AppLocale) => void;
  t: (text: string, vars?: AppTranslationVars) => string;
  bundle: AppTranslationBundle;
};

const AppI18nContext = createContext<AppI18nContextValue | null>(null);

const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const;
const SKIP_TRANSLATION_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
const NO_TRANSLATE_SELECTOR = '[data-rv-no-translate="true"]';

function canonicalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function translateString(text: string, lookup: Map<string, string>, vars?: AppTranslationVars): string {
  const normalized = canonicalizeText(text);
  if (!normalized) {
    return text;
  }

  const translated = lookup.get(normalized);
  if (!translated) {
    return interpolateAppTranslation(text, vars);
  }

  const leadingWhitespace = text.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = text.match(/\s*$/)?.[0] ?? '';
  return `${leadingWhitespace}${interpolateAppTranslation(translated, vars)}${trailingWhitespace}`;
}

function translateTextNode(node: Node, lookup: Map<string, string>): void {
  const parentElement = node.parentElement;
  if (!parentElement || SKIP_TRANSLATION_TAGS.has(parentElement.tagName)) {
    return;
  }

  const currentText = node.nodeValue ?? '';
  const nextText = translateString(currentText, lookup);
  if (nextText !== currentText) {
    node.nodeValue = nextText;
  }
}

function translateAttributes(element: Element, lookup: Map<string, string>): void {
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const currentValue = element.getAttribute(attribute);
    if (!currentValue) {
      continue;
    }

    const nextValue = translateString(currentValue, lookup);
    if (nextValue !== currentValue) {
      element.setAttribute(attribute, nextValue);
    }
  }
}

function isNoTranslateElement(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE
    && (node as Element).getAttribute('data-rv-no-translate') === 'true';
}

/** `node` lies in a `data-rv-no-translate` subtree (itself included). */
function isInsideNoTranslate(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(NO_TRANSLATE_SELECTOR));
}

/**
 * Translates `root` and its descendants (text nodes + translatable
 * attributes) in a single walk; `data-rv-no-translate` subtrees are skipped
 * whole. The caller checks that `root` itself is not inside one.
 */
function translateSubtree(root: Node, lookup: Map<string, string>): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root, lookup);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  translateAttributes(root as Element, lookup);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isNoTranslateElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      translateTextNode(node, lookup);
    } else {
      translateAttributes(node as Element, lookup);
    }
  }
}

export function AppI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredAppLocale);
  const [bundle, setBundle] = useState<AppTranslationBundle>(() => createAppTranslationBundle(readStoredAppLocale()));

  const translationLookup = useMemo(() => {
    const lookup = new Map<string, string>();

    for (const [source, target] of Object.entries(bundle.entries)) {
      lookup.set(canonicalizeText(source), target);
    }

    return lookup;
  }, [bundle.entries]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStoredAppLocale(locale);
  }, [locale]);

  useEffect(() => {
    let cancelled = false;

    setBundle(createAppTranslationBundle(locale));

    void fetch(`/api/app-translations?locale=${locale}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Translation bundle request failed with ${response.status}`);
        }

        const nextBundle = (await response.json()) as Partial<AppTranslationBundle>;
        if (cancelled) {
          return;
        }

        if (!nextBundle || typeof nextBundle !== 'object' || !nextBundle.entries) {
          throw new Error('Invalid translation bundle payload');
        }

        setBundle({
          locale: resolveAppLocale(nextBundle.locale),
          entries: nextBundle.entries,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setBundle(createAppTranslationBundle(locale));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) {
      return;
    }

    // Incremental: only the nodes a mutation touched are re-translated. A
    // full walk of #root on every mutation cost O(whole DOM) per frame — with
    // 800 POI rows in the timeline, any tooltip or clock tick paid for it.
    let frameId = 0;
    const pendingNodes = new Set<Node>();
    const pendingAttributes = new Set<Element>();

    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach((node) => pendingNodes.add(node));
        } else if (record.type === 'characterData') {
          pendingNodes.add(record.target);
        } else if (record.target.nodeType === Node.ELEMENT_NODE) {
          pendingAttributes.add(record.target as Element);
        }
      }
    };

    const runTranslation = () => {
      frameId = 0;
      collect(observer.takeRecords());
      for (const node of pendingNodes) {
        if (node.isConnected && !isInsideNoTranslate(node)) {
          translateSubtree(node, translationLookup);
        }
      }
      for (const element of pendingAttributes) {
        if (element.isConnected && !isInsideNoTranslate(element)) {
          translateAttributes(element, translationLookup);
        }
      }
      pendingNodes.clear();
      pendingAttributes.clear();
      // Records queued by now come from our own writes (the pass is
      // synchronous): already translated, drop them.
      observer.takeRecords();
    };

    const observer = new MutationObserver((records) => {
      collect(records);
      if (frameId === 0 && (pendingNodes.size > 0 || pendingAttributes.size > 0)) {
        frameId = window.requestAnimationFrame(runTranslation);
      }
    });

    pendingNodes.add(root);
    runTranslation();

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });

    return () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [translationLookup]);

  const value = useMemo<AppI18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (text: string, vars?: AppTranslationVars) => translateString(text, translationLookup, vars),
      bundle,
    }),
    [bundle, locale, translationLookup],
  );

  return <AppI18nContext.Provider value={value}>{children}</AppI18nContext.Provider>;
}

export function useAppI18n(): AppI18nContextValue {
  const context = useContext(AppI18nContext);
  if (!context) {
    throw new Error('useAppI18n must be used within AppI18nProvider');
  }

  return context;
}