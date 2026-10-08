import { describe, expect, it } from 'vitest';

import { isSessionRejectedError } from './appwriteErrors';

describe('isSessionRejectedError', () => {
  it('session absente ou expirée (401)', () => {
    expect(isSessionRejectedError({ code: 401, type: 'user_unauthorized' })).toBe(true);
  });

  it('compte bloqué : 401 jusqu’à Appwrite 1.8, 403 depuis 1.9', () => {
    expect(isSessionRejectedError({ code: 401, type: 'user_blocked' })).toBe(true);
    expect(isSessionRejectedError({ code: 403, type: 'user_blocked' })).toBe(true);
  });

  it('les autres erreurs gardent la session (réseau, serveur, droits sur une ressource)', () => {
    expect(isSessionRejectedError({ code: 403, type: 'user_unauthorized' })).toBe(false);
    expect(isSessionRejectedError({ code: 500 })).toBe(false);
    expect(isSessionRejectedError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionRejectedError(null)).toBe(false);
  });
});
