// Connexion lente au serveur temps réel, pour un seul chargement de page :
// les messages reçus sur /multiplayer (dont `welcome`) sont retardés de
// `sessionStorage['rv-e2e-slow-welcome']` ms à partir de l'ouverture de la
// socket, dans l'ordre ; l'envoi n'est pas touché. Sert à vérifier qu'une
// modification faite pendant la connexion n'est jamais perdue.
//
//   await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_WELCOME_SCRIPT });
//   await page.evaluate(armSlowWelcome(3000));   // puis Page.reload

export const SLOW_WELCOME_SCRIPT = `(() => {
  let delay = 0;
  try {
    delay = Number(sessionStorage.getItem('rv-e2e-slow-welcome') || 0);
    sessionStorage.removeItem('rv-e2e-slow-welcome');
  } catch { /* stockage indisponible */ }
  if (!delay) return;
  const Real = window.WebSocket;
  function SlowWebSocket(url, protocols) {
    const socket = new Real(url, protocols);
    if (!String(url).includes('/multiplayer')) return socket;
    const until = performance.now() + delay;
    let handler = null;
    socket.addEventListener('message', (event) => {
      setTimeout(() => handler && handler.call(socket, event), Math.max(0, until - performance.now()));
    });
    Object.defineProperty(socket, 'onmessage', { get: () => handler, set: (value) => { handler = value; }, configurable: true });
    return socket;
  }
  SlowWebSocket.prototype = Real.prototype;
  Object.assign(SlowWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = SlowWebSocket;
})()`;

/** À évaluer dans la page juste avant le rechargement. */
export const armSlowWelcome = (ms) => `sessionStorage.setItem('rv-e2e-slow-welcome', ${JSON.stringify(String(ms))})`;
