// Journal des connexions temps réel d'une page, pour diagnostiquer un E2E :
// création, `welcome`, erreurs du serveur, fermeture (code, raison) de chaque
// socket /multiplayer, et toasts affichés. Gardé dans le sessionStorage de
// l'onglet : il survit aux rechargements. À injecter avant SLOW_WELCOME_SCRIPT
// (qui enveloppe ensuite ce WebSocket).
//
//   await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_LOG_SCRIPT });
//   const log = await page.evaluate(READ_SOCKET_LOG);

const KEY = 'rv-e2e-socket-log';

export const SOCKET_LOG_SCRIPT = `(() => {
  const log = (entry) => {
    try {
      const all = JSON.parse(sessionStorage.getItem(${JSON.stringify(KEY)}) || '[]');
      all.push({ at: new Date().toISOString(), page: location.pathname.slice(0, 60), ...entry });
      sessionStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(all.slice(-300)));
    } catch { /* stockage indisponible */ }
  };
  const Real = window.WebSocket;
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (String(args[0]).includes('/multiplayer')) {
        log({ event: 'open' });
        socket.addEventListener('close', (event) => log({ event: 'close', code: event.code, reason: event.reason }));
        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'welcome') log({ event: 'welcome', seq: message.seq, snapshot: !!message.snapshot, clientSeq: message.clientSeq });
            else if (message.type === 'error' || message.type === 'reject') log({ event: message.type, code: message.code, reason: message.reason ?? message.message });
          } catch { /* message illisible */ }
        });
      }
      return socket;
    },
  });
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
      if (seen.has(toast)) continue;
      seen.add(toast);
      log({ event: 'toast', text: (toast.textContent || '').slice(0, 200) });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})()`;

export const READ_SOCKET_LOG = `JSON.parse(sessionStorage.getItem(${JSON.stringify(KEY)}) || '[]')`;

/** Fermetures qui renvoient un client hors d'un projet (refus définitifs). */
export const DENIAL_CODES = new Set([4401, 4403, 4404, 4426]);
