// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

const api = vi.hoisted(() => ({
  request: vi.fn(async () => ({ alreadyVerified: false })),
  confirm: vi.fn(async (_code: string) => {}),
  deleteSession: vi.fn(async () => ({})),
}));
vi.mock('../lib/emailVerification', () => ({ requestAccountEmailCode: api.request, confirmAccountEmail: api.confirm }));
vi.mock('@/shared/services/appwrite', () => ({ account: { deleteSession: api.deleteSession }, clearStoredAppwriteSession: () => {} }));
const notifyError = vi.hoisted(() => vi.fn());
vi.mock('@/shared/lib/notify', () => ({ notify: { error: notifyError } }));

const { default: VerifyEmailScreen } = await import('./VerifyEmailScreen');

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  vi.clearAllMocks();
});

describe('VerifyEmailScreen (A15-2)', () => {
  it('envoie un code à l’ouverture, ouvre l’app une fois le bon code saisi', async () => {
    const onVerified = vi.fn();
    view = renderComponent(<VerifyEmailScreen onVerified={onVerified} onSignedOut={() => {}} />);
    await act(async () => {});
    expect(api.request).toHaveBeenCalledTimes(1);
    const inputs = [...view.container.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs).toHaveLength(6);
    await act(async () => {
      const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
      paste.clipboardData = { getData: () => '123456' };
      inputs[0].dispatchEvent(paste);
    });
    expect(api.confirm).toHaveBeenCalledWith('123456');
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('fermer = se déconnecter, on n’entre pas sans adresse vérifiée', async () => {
    const onSignedOut = vi.fn();
    view = renderComponent(<VerifyEmailScreen onVerified={() => {}} onSignedOut={onSignedOut} />);
    await act(async () => {
      view!.button('Fermer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.deleteSession).toHaveBeenCalledWith('current');
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('adresse déjà vérifiée entre-temps : l’app s’ouvre sans code', async () => {
    api.request.mockResolvedValueOnce({ alreadyVerified: true });
    const onVerified = vi.fn();
    view = renderComponent(<VerifyEmailScreen onVerified={onVerified} onSignedOut={() => {}} />);
    await act(async () => {});
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('premier envoi en échec : un message le dit (pas seulement la console)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.request.mockRejectedValueOnce(new Error('L’e-mail de confirmation n’a pas pu partir. Réessayez plus tard.'));
    view = renderComponent(<VerifyEmailScreen onVerified={() => {}} onSignedOut={() => {}} />);
    await act(async () => {});
    expect(notifyError).toHaveBeenCalledWith('L’e-mail de confirmation n’a pas pu partir. Réessayez plus tard.');
  });
});
