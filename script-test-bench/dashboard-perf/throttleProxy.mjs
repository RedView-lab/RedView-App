/**
 * Proxy HTTP/HTTPS local qui modélise un lien lent au niveau des connexions,
 * comme le « packet-level throttling » de WebPageTest, pour tout le trafic du
 * navigateur (`--proxy-server`, boucle locale comprise) :
 *   - délai aller-retour : rtt/2 sur chaque morceau montant et descendant,
 *     plus un aller-retour à l'ouverture de chaque connexion (poignée TCP) ;
 *     la poignée TLS, chiffrée dans le tunnel, paie ses vrais allers-retours ;
 *   - débit : un lien montant et un lien descendant partagés par toutes les
 *     connexions (sérialisation par morceaux de 16 Kio, ordre préservé).
 * L'émulation réseau des DevTools (`Network.emulateNetworkConditions`) ne
 * s'applique qu'à la cible où elle est posée : les requêtes du Service Worker
 * (tuiles DEM, pente, ortho) lui échappaient.
 * Octets reçus comptés par hôte (statiques de l'app, Mapbox, tuiles…).
 */
import http from 'node:http';
import net from 'node:net';

const CHUNK = 16 * 1024;

/** Lien à débit fixe : renvoie l'instant de livraison de chaque morceau, dans l'ordre. */
function createLink(kbps, oneWayMs) {
  let freeAt = 0;
  return (bytes) => {
    const now = performance.now();
    const serialisation = kbps > 0 ? (bytes * 8) / kbps : 0;
    freeAt = Math.max(freeAt, now) + serialisation;
    return freeAt + oneWayMs;
  };
}

/**
 * Flux mis en forme vers `target` : chaque morceau reçoit son instant de
 * livraison du lien, puis une file par flux les livre dans l'ordre — la fin
 * comprise. (Deux minuteurs à la même échéance ne garantissent pas leur ordre :
 * la fin partait parfois avant le dernier morceau, ERR_CONTENT_LENGTH_MISMATCH.)
 */
function shapedStream(link, target, onBytes) {
  const queue = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now + 0.5) {
      const item = queue.shift();
      if (target.destroyed) continue;
      if (item.part) target.write(item.part);
      else target.end();
    }
    if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].at - performance.now()));
  };
  const push = (item) => {
    queue.push(item);
    if (!timer) timer = setTimeout(pump, Math.max(0, queue[0].at - performance.now()));
  };
  return {
    write(chunk) {
      for (let offset = 0; offset < chunk.length; offset += CHUNK) {
        const part = chunk.subarray(offset, offset + CHUNK);
        onBytes?.(part.length);
        push({ at: link(part.length), part });
      }
    },
    end() {
      push({ at: link(0), part: null });
    },
  };
}

/**
 * @param {{ rttMs: number, downKbps: number, upKbps: number }} profile
 */
export async function startThrottleProxy(profile) {
  const oneWay = profile.rttMs / 2;
  const down = createLink(profile.downKbps, oneWay);
  const up = createLink(profile.upKbps, oneWay);
  const bytesByHost = new Map();
  const count = (host) => (bytes) => bytesByHost.set(host, (bytesByHost.get(host) ?? 0) + bytes);
  const handshake = () => new Promise((resolve) => setTimeout(resolve, profile.rttMs));

  // Toutes les sockets, tunnels compris (`closeAllConnections` ne voit pas
  // celles d'un CONNECT) : détruites à l'arrêt, sinon `close` attend qu'un CDN
  // ferme sa connexion.
  const sockets = new Set();
  const track = (socket) => {
    // Une socket gardée en vie par l'agent HTTP sert plusieurs requêtes : suivie une fois.
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };

  // HTTPS : tunnel CONNECT, octets chiffrés relayés à travers les deux liens.
  const server = http.createServer();
  server.on('connect', async (req, client, head) => {
    const [host, port] = req.url.split(':');
    const upstream = track(net.connect(Number(port) || 443, host));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    await handshake();
    if (client.destroyed) return upstream.destroy();
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const toServer = shapedStream(up, upstream);
    const toClient = shapedStream(down, client, count(host));
    if (head?.length) toServer.write(head);
    client.on('data', (chunk) => toServer.write(chunk));
    upstream.on('data', (chunk) => toClient.write(chunk));
    client.on('end', () => toServer.end());
    upstream.on('end', () => toClient.end());
  });

  // HTTP en clair (serveur local de l'app) : requête relayée vers l'hôte cible.
  const freshSockets = new WeakSet();
  server.on('connection', (socket) => {
    track(socket);
    freshSockets.add(socket);
  });
  server.on('request', async (req, res) => {
    const target = new URL(req.url);
    if (freshSockets.has(req.socket)) {
      freshSockets.delete(req.socket);
      await handshake();
    }
    const { 'proxy-connection': _proxyConnection, ...headers } = req.headers;
    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    });
    upstream.on('error', () => res.destroy());
    upstream.on('socket', track);
    const toServer = shapedStream(up, upstream);
    req.on('data', (chunk) => toServer.write(chunk));
    req.on('end', () => toServer.end());
    upstream.on('response', (response) => {
      const headerBytes = 200 + Object.entries(response.headers).reduce((sum, [k, v]) => sum + k.length + String(v).length + 4, 0);
      const at = down(headerBytes);
      count(target.host)(headerBytes);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(response.statusCode ?? 502, response.headers);
        const toClient = shapedStream(down, res, count(target.host));
        response.on('data', (chunk) => toClient.write(chunk));
        response.on('end', () => toClient.end());
      }, Math.max(0, at - performance.now()));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    bytesByHost,
    resetCounters: () => bytesByHost.clear(),
    stop: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
