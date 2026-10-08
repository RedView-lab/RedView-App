import { translateAppText } from '@/shared/i18n/config';

function createStyledElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cssText: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.style.cssText = cssText;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function showFatalError(
  overlay: HTMLElement,
  opts: { title: string; message: string; hint?: string; technical?: string },
) {
  overlay.classList.remove('hidden');

  // Construit via le DOM (textContent) : les messages peuvent contenir des
  // fragments non maîtrisés (erreurs worker, paramètres d'URL…).
  // Above #overlay::before like the loader card: that positioned layer's
  // backdrop blur otherwise covers an unpositioned card (the error was unreadable).
  const card = createStyledElement('div', `
      position: relative;
      z-index: 1;
      max-width: 560px;
      padding: 28px 32px;
      background: rgba(20, 24, 40, 0.85);
      border: 1px solid rgba(255, 80, 80, 0.35);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      color: #fff;
      font-family: system-ui, sans-serif;
      text-align: center;
    `);
  card.appendChild(createStyledElement('div', 'font-size: 40px; margin-bottom: 8px;', '⚠️'));
  card.appendChild(createStyledElement('h1', 'font-size: 1.35rem; margin: 0 0 12px; color:#ffb4b4;', translateAppText(opts.title)));
  card.appendChild(
    createStyledElement('p', 'font-size: 0.95rem; line-height: 1.55; color:#e6e8f0; margin: 0 0 14px;', translateAppText(opts.message)),
  );
  if (opts.hint) {
    card.appendChild(createStyledElement('p', 'font-size:0.85rem; color:#9aa3bd; margin:0 0 14px;', translateAppText(opts.hint)));
  }
  if (opts.technical) {
    const details = createStyledElement('details', 'margin-top:10px; text-align:left;');
    details.appendChild(
      createStyledElement('summary', 'cursor:pointer; color:#7ea1ff; font-size:0.8rem;', translateAppText('Détails techniques')),
    );
    details.appendChild(createStyledElement('pre', `
            margin-top: 8px; padding: 10px; font-size: 11px;
            background: rgba(0,0,0,0.45); border-radius: 6px;
            color:#cfd6e8; white-space: pre-wrap; word-break: break-word;
          `, opts.technical));
    card.appendChild(details);
  }
  const closeButton = createStyledElement('button', `
        margin-top: 18px; padding: 8px 18px;
        background: rgba(80,120,255,0.25); color:#fff;
        border: 1px solid rgba(120,160,255,0.55);
        border-radius: 999px; cursor: pointer; font-size: 0.9rem;
      `, translateAppText("Fermer l'onglet"));
  closeButton.id = 'err-close';
  closeButton.addEventListener('click', () => window.close());
  card.appendChild(closeButton);

  overlay.replaceChildren(card);
}

/**
 * What to try when no engine starts. On Linux the usual cause is the
 * browser's GPU acceleration being off or the driver blocklisted: without
 * it there is no WebGL at all (Chrome no longer falls back to SwiftShader).
 */
export function noEngineHint(): string {
  const ua = navigator.userAgent;
  if (/linux/i.test(ua) && !/android/i.test(ua)) {
    return "Sous Linux : activez l'accélération matérielle du navigateur (Chrome : chrome://settings/system puis chrome://gpu ; Firefox : about:support, section Graphiques) et installez des pilotes graphiques Mesa ou NVIDIA récents.";
  }
  return 'Mettez à jour vos pilotes graphiques ou utilisez un navigateur récent.';
}

export function explainWorkerError(raw: string): { title: string; message: string; hint?: string } {
  if (/Exception catching is disabled/i.test(raw) || /^\d{6,}\s*-\s*Exception/.test(raw)) {
    return {
      title: 'Décodage LAZ impossible',
      message:
        "Le décodeur LiDAR (laz-perf, WebAssembly) a levé une exception interne qu'il ne peut pas décrire. " +
        "C'est en général dû à une mémoire insuffisante pendant la décompression (les machines sans GPU dédié partagent leur RAM avec le processeur graphique) " +
        'ou à une tuile partiellement téléchargée.',
      hint:
        "Essayez de supprimer puis re-télécharger la tuile, fermez les autres onglets gourmands, " +
        "ou ouvrez le visualiseur sur une machine équipée d'une carte graphique dédiée.",
    };
  }
  return {
    title: 'Erreur de chargement',
    message: raw,
  };
}
