import { describe, expect, it } from 'vitest';

import type { ApiResponse } from '../types';
import { rejectUnverifiedEmail } from '../appwrite';

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(data: unknown) { out.body = data; return res; },
  } as unknown as ApiResponse;
  return { res, out };
}

describe('rejectUnverifiedEmail (A15-2)', () => {
  it('refuse en 403 un compte dont l’adresse n’est pas prouvée', () => {
    const { res, out } = fakeRes();
    expect(rejectUnverifiedEmail({ emailVerified: false }, res)).toBe(true);
    expect(out).toEqual({ status: 403, body: { error: 'Confirmez d’abord votre adresse e-mail.', code: 'email_unverified' } });
  });

  it('laisse passer une adresse vérifiée', () => {
    const { res, out } = fakeRes();
    expect(rejectUnverifiedEmail({ emailVerified: true }, res)).toBe(false);
    expect(out.status).toBe(0);
  });
});
