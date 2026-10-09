// Préchargé dans le serveur sous test (--import) : aucune connexion TCP hors
// de la boucle locale. Les appels vers un service tiers échouent comme une
// panne réseau, rien ne sort de la machine.
import net from 'node:net';
import dns from 'node:dns';

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', undefined, '']);
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const first = args[0];
  const options = typeof first === 'object' && first !== null ? (Array.isArray(first) ? first[0] : first) : null;
  const host = options ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
  const isPipe = options && typeof options.path === 'string';
  if (!isPipe && !LOCAL.has(host)) {
    process.nextTick(() => this.destroy(Object.assign(new Error(`egress blocked: ${host}`), { code: 'ECONNREFUSED' })));
    return this;
  }
  return originalConnect.apply(this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (!LOCAL.has(hostname)) {
    process.nextTick(() => cb(Object.assign(new Error(`dns blocked: ${hostname}`), { code: 'ENOTFOUND' })));
    return {};
  }
  return originalLookup.call(dns, hostname, options, callback);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!LOCAL.has(url.hostname)) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`egress blocked: ${url.hostname}`), { code: 'ECONNREFUSED' }) });
  return originalFetch(input, init);
};
