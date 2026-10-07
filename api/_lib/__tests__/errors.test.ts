import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResponse } from '../types';

const { captureServerError } = vi.hoisted(() => ({ captureServerError: vi.fn() }));
vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError }));

const { PublicError, sendSafeError } = await import('../errors');

function fakeResponse() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(data: unknown) { out.body = data; return res; },
  } as unknown as ApiResponse;
  return { res, out };
}

describe('sendSafeError', () => {
  beforeEach(() => {
    captureServerError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns a public refusal as is, as a warning, without reporting it', () => {
    const { res, out } = fakeResponse();
    sendSafeError(res, new PublicError('Too many invitations, try again later', 429), 'Sharing failed', 'projects/share');
    expect(out).toEqual({ status: 429, body: { error: 'Too many invitations, try again later' } });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it('hides an internal error behind the fallback and reports it to GlitchTip', () => {
    const { res, out } = fakeResponse();
    const internal = new Error('Appwrite 503: database locked');
    sendSafeError(res, internal, 'Sharing failed', 'projects/share');
    expect(out).toEqual({ status: 500, body: { error: 'Sharing failed' } });
    expect(captureServerError).toHaveBeenCalledWith(internal, { route: 'projects/share' });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('logs a public 5xx as an error', () => {
    const { res, out } = fakeResponse();
    sendSafeError(res, new PublicError('Stripe is unavailable', 503), 'Billing failed', 'billing/overview');
    expect(out.status).toBe(503);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(captureServerError).not.toHaveBeenCalled();
  });
});
