// Pilote CDP minimal pour Edge sans interface (WebSocket global de Node ≥ 22), profil jetable.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export async function launch({ port = 9333, headless = true, extraArgs = [] } = {}) {
  const userDir = mkdtempSync(path.join(tmpdir(), 'rv-edge-'));
  const args = [
    headless ? '--headless=new' : '',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--window-size=1920,1080',
    ...extraArgs,
    'about:blank',
  ].filter(Boolean);
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!version) throw new Error('Edge did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const session = await connect(page.webSocketDebuggerUrl);
  const close = async () => {
    // En douceur d'abord (Browser.close termine les enfants rendu / GPU), puis
    // tout l'arbre, puis le profil jetable (les caches de tuiles du SW
    // grossissent vite).
    try {
      await Promise.race([session.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* déjà parti */
    }
    try {
      session.ws.close();
    } catch {
      /* ignore */
    }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(userDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };
  return { proc, session, close };
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result.value;
  };
  return { send, on, evaluate, ws };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(session, expression, { timeout = 30000, interval = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await session.evaluate(expression);
      if (v) return v;
    } catch {
      /* page en cours de navigation */
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}
