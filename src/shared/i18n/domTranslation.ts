import { canonicalizeAppText, interpolateAppTranslation, type AppTranslationVars } from './config';

/**
 * Traduction du DOM : les nœuds texte et les attributs
 * `aria-label`/`placeholder`/`title` dont le texte (canonisé) correspond à une
 * paire de traduction sont réécrits sur place. Partagée par `AppI18nProvider`
 * (application, `#root`) et le visualiseur LiDAR autonome (`viewer.html`,
 * `document.body`).
 */

const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const;
const SKIP_TRANSLATION_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
const NO_TRANSLATE_SELECTOR = '[data-rv-no-translate="true"]';

export type TranslationLookup = Map<string, string>;

const canonicalizeText = canonicalizeAppText;

export function buildTranslationLookup(entries: Record<string, string>): TranslationLookup {
  const lookup: TranslationLookup = new Map();
  for (const [source, target] of Object.entries(entries)) {
    lookup.set(canonicalizeText(source), target);
  }
  return lookup;
}

export function translateString(text: string, lookup: TranslationLookup, vars?: AppTranslationVars): string {
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

function translateTextNode(node: Node, lookup: TranslationLookup): void {
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

function translateAttributes(element: Element, lookup: TranslationLookup): void {
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

/** `node` est dans un sous-arbre `data-rv-no-translate` (lui-même compris). */
function isInsideNoTranslate(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(NO_TRANSLATE_SELECTOR));
}

/**
 * Traduit `root` et ses descendants (nœuds texte + attributs traduisibles) en
 * un seul parcours ; les sous-arbres `data-rv-no-translate` sont sautés en
 * entier. L'appelant vérifie que `root` lui-même n'est pas dans l'un d'eux.
 */
function translateSubtree(root: Node, lookup: TranslationLookup): void {
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

/**
 * Traduit `root` tout de suite, puis chaque nœud touché par une mutation
 * (regroupés par image d'animation). Renvoie la fonction de déconnexion.
 */
export function observeDomTranslation(root: Node, lookup: TranslationLookup): () => void {
  // Incrémental : seuls les nœuds touchés par une mutation sont retraduits. Un
  // parcours complet de la racine à chaque mutation coûtait O(tout le DOM) par
  // image — avec 800 lignes de POI dans la frise, la moindre infobulle ou le
  // moindre tic d'horloge le payait.
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
        translateSubtree(node, lookup);
      }
    }
    for (const element of pendingAttributes) {
      if (element.isConnected && !isInsideNoTranslate(element)) {
        translateAttributes(element, lookup);
      }
    }
    pendingNodes.clear();
    pendingAttributes.clear();
    // Les enregistrements en file à ce stade viennent de nos propres écritures
    // (la passe est synchrone) : déjà traduits, on les jette.
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
}
