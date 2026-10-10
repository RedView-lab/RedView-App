import { describe, it, expect } from 'vitest'
import { authUrlErrorMessage } from './useAuthUrlParams'

function messageFor(search: string): string | null {
  return authUrlErrorMessage(new URLSearchParams(search))
}

describe('authUrlErrorMessage', () => {
  it('un « % » dans ?message= ne fait plus planter la page de connexion (A8-1)', () => {
    expect(() => messageFor('?message=%25')).not.toThrow()
    expect(() => messageFor('?error=Paiement%20refus%C3%A9%20%C3%A0%20100%25')).not.toThrow()
  })

  it('un texte arbitraire de l’URL n’est jamais affiché (hameçonnage, A8-2)', () => {
    expect(messageFor('?message=Compte%20suspendu%2C%20appelez%20le%2001%2023%2045%2067%2089')).toBeNull()
  })

  it('un échec OAuth affiche un message de l’app, pas le JSON d’Appwrite', () => {
    const appwriteJson = encodeURIComponent('{"message":"Invalid OAuth2 Response","type":"user_oauth2_unauthorized","code":401}')
    expect(messageFor(`?oauth=failed&error=${appwriteJson}`)).toBe('La connexion avec Google a échoué. Réessayez.')
    expect(messageFor(`?error=${appwriteJson}`)).toBe('La connexion avec Google a échoué. Réessayez.')
  })

  it('URL ordinaire : rien', () => {
    expect(messageFor('')).toBeNull()
    expect(messageFor('?utm_source=x')).toBeNull()
  })
})
