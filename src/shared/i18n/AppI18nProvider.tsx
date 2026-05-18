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
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationBundle,
} from './config';

type AppI18nContextValue = {
  locale: AppLocale;
  setLocale: (nextLocale: AppLocale) => void;
  t: (text: string) => string;
  bundle: AppTranslationBundle;
};

const AppI18nContext = createContext<AppI18nContextValue | null>(null);

const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const;
const SKIP_TRANSLATION_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

function canonicalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function translateString(text: string, lookup: Map<string, string>): string {
  const normalized = canonicalizeText(text);
  if (!normalized) {
    return text;
  }

  const translated = lookup.get(normalized);
  if (!translated) {
    return text;
  }

  const leadingWhitespace = text.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = text.match(/\s*$/)?.[0] ?? '';
  return `${leadingWhitespace}${translated}${trailingWhitespace}`;
}

function translateSubtree(root: ParentNode, lookup: Map<string, string>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parentElement = node.parentElement;

    if (!parentElement || SKIP_TRANSLATION_TAGS.has(parentElement.tagName)) {
      continue;
    }

    if (parentElement.closest('[data-rv-no-translate="true"]')) {
      continue;
    }

    const nextText = translateString(node.nodeValue ?? '', lookup);
    if (nextText !== (node.nodeValue ?? '')) {
      node.nodeValue = nextText;
    }
  }

  if (!(root instanceof Element) && !(root instanceof Document)) {
    return;
  }

  const scope = root instanceof Document ? root.documentElement : root;
  if (!scope) {
    return;
  }

  scope.querySelectorAll('*').forEach((element) => {
    if (element.closest('[data-rv-no-translate="true"]')) {
      return;
    }

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
  });
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

    let frameId = 0;

    const runTranslation = () => {
      frameId = 0;
      translateSubtree(root, translationLookup);
    };

    const scheduleTranslation = () => {
      if (frameId !== 0) {
        return;
      }

      frameId = window.requestAnimationFrame(runTranslation);
    };

    runTranslation();

    const observer = new MutationObserver(scheduleTranslation);
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
      t: (text: string) => translateString(text, translationLookup),
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