import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captured = vi.hoisted(() => ({ errors: [] as unknown[] }));
vi.mock('../../../server/lib/observability.mjs', () => ({
  captureServerError: (error: unknown) => { captured.errors.push(error); },
}));

// Le quota par adresse vit dans le magasin de codes, écrit dans os.tmpdir() :
// un dossier à part, pas celui du serveur de dev.
const { storeDir } = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return { storeDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rv-forgot-')) };
});
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: { ...actual, tmpdir: () => storeDir }, tmpdir: () => storeDir };
});

const { default: handler } = await import('../../auth/forgot-password');
import type { ApiRequest, ApiResponse } from '../types';

let addressSeq = 0;
/** Une adresse neuve par appel : le quota par adresse (30 s) ne s'en mêle pas. */
function freshEmail(): string {
  addressSeq += 1;
  return `rider${addressSeq}@example.test`;
}

interface Captured {
  status: number;
  body: { error?: string; success?: boolean; message?: string } | undefined;
}

function call(body: Record<string, unknown>): { done: Promise<Captured>; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader() { return res; },
    json(data: Captured['body']) { captured.body = data; return res; },
  } as unknown as ApiResponse;
  const req = { method: 'POST', query: {}, headers: {}, body } as unknown as ApiRequest;
  return { done: Promise.resolve(handler(req, res)).then(() => captured), captured };
}

function sentRecovery(fetchMock: ReturnType<typeof vi.fn>): { email: string; url: string } {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as { email: string; url: string };
}

describe('api/auth/forgot-password', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubEnv('APPWRITE_ENDPOINT', 'https://appwrite.test/v1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APPWRITE_API_KEY', 'standard_test_key');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captured.errors.length = 0;
    fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('demande la récupération à Appwrite et répond après un délai fixe, même si Appwrite traîne', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { done, captured } = call({ email: ' Rider@Example.test ', redirectUrl: 'https://app.redview.tech/' });
    await vi.advanceTimersByTimeAsync(299);
    expect(captured.status).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body?.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://appwrite.test/v1/account/recovery');
    expect(sentRecovery(fetchMock)).toEqual({ email: 'rider@example.test', url: 'https://app.redview.tech/' });
  });

  it('remplace une redirection hors liste blanche par l’app', async () => {
    const { done } = call({ email: freshEmail(), redirectUrl: 'https://evil.example/steal' });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(sentRecovery(fetchMock).url).toBe('https://app.redview.tech/');
  });

  it('refuse localhost en production', async () => {
    const { done } = call({ email: freshEmail(), redirectUrl: 'http://localhost:5173/' });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(sentRecovery(fetchMock).url).toBe('https://app.redview.tech/');
  });

  it('appelle Appwrite avec la clé d’API : la limite par IP (celle du serveur, partagée par tous) ne s’applique pas (A1-1)', async () => {
    const { done } = call({ email: freshEmail() });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Appwrite-Key']).toBe('standard_test_key');
  });

  it('plus de 10 demandes par heure, pour des adresses différentes : chacune part (A1-1)', async () => {
    for (let index = 0; index < 12; index += 1) {
      const { done } = call({ email: freshEmail() });
      await vi.advanceTimersByTimeAsync(300);
      expect((await done).status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('quota par adresse : une seconde demande dans les 30 s ne part pas, la réponse reste neutre', async () => {
    const email = freshEmail();
    let pending = call({ email });
    await vi.advanceTimersByTimeAsync(300);
    await pending.done;
    pending = call({ email });
    await vi.advanceTimersByTimeAsync(300);
    const out = await pending.done;
    expect(out.status).toBe(200);
    expect(out.body?.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('une clé refusée (401) est signalée et la demande repart sans clé', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"type":"general_unauthorized_scope"}', { status: 401 }));
    const { done } = call({ email: freshEmail() });
    await vi.advanceTimersByTimeAsync(300);
    expect((await done).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders['X-Appwrite-Key']).toBeUndefined();
    expect(captured.errors).toHaveLength(1);
  });

  it('un 429 d’Appwrite n’est plus attendu : journalisé et signalé à GlitchTip, sans changer la réponse', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limit', { status: 429 }));
    const { done } = call({ email: freshEmail() });
    await vi.advanceTimersByTimeAsync(300);
    expect((await done).status).toBe(200);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(captured.errors.map((error) => String(error))).toEqual(['Error: Appwrite recovery HTTP 429']);
  });

  it('signale à GlitchTip une récupération qu’Appwrite refuse ou n’atteint pas', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"type":"general_argument_invalid"}', { status: 400 }));
    let pending = call({ email: freshEmail() });
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending.done).status).toBe(200);
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    pending = call({ email: freshEmail() });
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending.done).status).toBe(200);
    expect(captured.errors.map((error) => String(error))).toEqual([
      'Error: Appwrite recovery HTTP 400',
      'Error: connect ECONNREFUSED',
    ]);
  });

  it('ne journalise pas une adresse sans compte (404)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":404}', { status: 404 }));
    const { done } = call({ email: 'nobody@example.test' });
    await vi.advanceTimersByTimeAsync(300);
    expect((await done).status).toBe(200);
    expect(console.error).not.toHaveBeenCalled();
    expect(captured.errors).toEqual([]);
  });

  it('refuse une adresse invalide sans appeler Appwrite', async () => {
    const out = await call({ email: 'pas-une-adresse' }).done;
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
