import { describe, it, expect, vi } from 'vitest';
import type { ApiRequest } from '../types';

vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError: vi.fn() }));

const { parseApiBody } = await import('../../../server/lib/api-request.mjs');
const { PublicError } = await import('../errors');
const { readJsonBody } = await import('../http');

/** Requête telle que la construisent server.mjs et le plugin de dev. */
function apiRequest(raw: string, contentType = 'application/json'): ApiRequest {
  const rawBody = Buffer.from(raw, 'utf8');
  return {
    body: parseApiBody(rawBody, contentType),
    async *[Symbol.asyncIterator]() {
      yield rawBody;
    },
  } as unknown as ApiRequest;
}

async function rejection(req: ApiRequest): Promise<unknown> {
  try {
    await readJsonBody(req);
  } catch (error) {
    return error;
  }
  throw new Error('readJsonBody should have thrown');
}

describe('readJsonBody', () => {
  it('returns the decoded JSON object', async () => {
    await expect(readJsonBody(apiRequest('{"action":"list","projectId":"p1"}'))).resolves.toEqual({
      action: 'list',
      projectId: 'p1',
    });
  });

  it('reads a JSON body sent without a JSON content type', async () => {
    await expect(readJsonBody(apiRequest('{"action":"leave"}', ''))).resolves.toEqual({ action: 'leave' });
  });

  it('treats an empty body as an empty object', async () => {
    await expect(readJsonBody(apiRequest(''))).resolves.toEqual({});
    await expect(readJsonBody(apiRequest('   ', 'text/plain'))).resolves.toEqual({});
  });

  it('refuses malformed JSON with a 400, not an internal error', async () => {
    const error = await rejection(apiRequest('{"action":'));
    expect(error).toBeInstanceOf(PublicError);
    expect((error as InstanceType<typeof PublicError>).status).toBe(400);
  });

  it.each(['null', '[1,2]', '42', '"text"', 'true'])('refuses a non-object JSON body (%s) with a 400', async (raw) => {
    const error = await rejection(apiRequest(raw));
    expect(error).toBeInstanceOf(PublicError);
    expect((error as InstanceType<typeof PublicError>).status).toBe(400);
  });
});
