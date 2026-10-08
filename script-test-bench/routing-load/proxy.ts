/**
 * Proxy du banc de charge du routage (processus enfant de run.ts, lancé dans
 * le dossier `ROUTING_LOAD_ROOT` : arbre de travail, ou copie d'un autre
 * commit) : le vrai `api/brouter.ts` de ce dossier, servi en HTTP comme le
 * fait server.mjs (`req.query`, corps texte, `res.status/json/send`, fermeture
 * de la connexion du client visible par le gestionnaire), sans la limite de
 * débit par IP — devant le faux BRouter (`BROUTER_UPSTREAM`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.ROUTING_LOAD_ROOT ?? process.cwd();
const { default: handler } = await import(pathToFileURL(path.join(root, 'api/brouter.ts')).href) as {
  default: (req: unknown, res: unknown) => Promise<unknown>;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://proxy');
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
    const apiReq = { method: req.method, url: req.url, query, body, headers: req.headers };
    const apiRes = Object.assign(res, {
      status(code: number) {
        res.statusCode = code;
        return apiRes;
      },
      json(data: unknown) {
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(data));
        return apiRes;
      },
      send(data: unknown) {
        if (Buffer.isBuffer(data) || typeof data === 'string') res.end(data);
        else apiRes.json(data);
        return apiRes;
      },
    });
    handler(apiReq, apiRes).catch((error: unknown) => {
      console.error('[proxy du banc]', error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
});
server.keepAliveTimeout = 30_000;
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: (server.address() as AddressInfo).port }));
process.on('disconnect', () => process.exit(0));
