import { describe, expect, it } from 'vitest';

import { appwriteFailureMessage, isSessionRejectedError } from './appwriteErrors';

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

describe('appwriteFailureMessage', () => {
  /** Forme d'une AppwriteException : message anglais pour développeur, `code`, `type`. */
  const appwrite = (code: number, type: string) => Object.assign(new Error('The current user has been blocked. You can unblock…'), { code, type });

  it('un type connu donne son message, jamais le message anglais d’Appwrite', () => {
    expect(appwriteFailureMessage(appwrite(401, 'user_invalid_credentials'), 'repli')).toBe('Adresse e-mail ou mot de passe incorrect.');
    expect(appwriteFailureMessage(appwrite(403, 'user_blocked'), 'repli')).toBe('Ce compte est désactivé.');
    expect(appwriteFailureMessage(appwrite(404, 'document_not_found'), 'repli')).toMatch(/^Cet élément n’existe plus/);
    expect(appwriteFailureMessage(appwrite(429, 'general_rate_limit_exceeded'), 'repli')).toMatch(/^Trop de tentatives/);
  });

  it('un type inconnu donne le repli ; le contexte peut adapter un type', () => {
    expect(appwriteFailureMessage(appwrite(500, 'general_unknown'), 'repli')).toBe('repli');
    expect(appwriteFailureMessage(appwrite(401, 'user_invalid_credentials'), 'repli', { user_invalid_credentials: 'autre' })).toBe('autre');
  });

  it('panne réseau : fetch rejeté ou AppwriteException de réseau (code 0)', () => {
    expect(appwriteFailureMessage(new TypeError('Failed to fetch'), 'repli')).toMatch(/^Impossible de joindre le serveur RedView/);
    expect(appwriteFailureMessage(new TypeError('Load failed'), 'repli')).toMatch(/^Impossible de joindre/);
    expect(appwriteFailureMessage(Object.assign(new Error('Network request failed'), { code: 0, type: '' }), 'repli')).toMatch(/^Impossible de joindre/);
  });

  it('nos propres erreurs gardent leur message ; un bug de code n’est pas une panne réseau', () => {
    expect(appwriteFailureMessage(new Error('Le partage du projet a échoué.'), 'repli')).toBe('Le partage du projet a échoué.');
    expect(appwriteFailureMessage(new TypeError("Cannot read properties of undefined (reading 'x')"), 'repli')).toBe('repli');
    expect(appwriteFailureMessage(null, 'repli')).toBe('repli');
  });
});
