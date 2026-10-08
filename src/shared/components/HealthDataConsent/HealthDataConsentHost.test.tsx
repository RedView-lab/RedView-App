// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Pop-in d'accord aux données de santé (.fit) : s'ouvre à la demande, dit
 * quelles données, pourquoi, où, combien de temps et comment retirer l'accord,
 * focus sur « Refuser », et toute sortie sans « J'accepte » vaut refus.
 */

const state = vi.hoisted(() => ({ user: { $id: 'moi', prefs: {} as Record<string, unknown> } }));
vi.mock('@/shared/services/appwrite', () => ({
  account: { updatePrefs: async (prefs: Record<string, unknown>) => { state.user.prefs = prefs; return state.user; } },
  getAppwriteUser: async () => state.user,
  getSessionUserIdSync: () => state.user.$id,
}));
vi.mock('@/shared/lib/notify', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const { HealthDataConsentHost } = await import('./HealthDataConsentHost');
const { ensureHealthDataConsent, resetHealthDataConsentCache } = await import('@/shared/services/healthDataConsent');

let view: RenderedComponent | null = null;

beforeEach(() => {
  state.user.prefs = {};
  resetHealthDataConsentCache();
  view = renderComponent(createElement(HealthDataConsentHost));
});

afterEach(() => {
  view?.unmount();
  view = null;
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="rv-health-consent-title"]');
const buttonByText = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text) ?? null;

/** Lance une demande et attend que la pop-in soit affichée (rend la promesse de réponse, dans un objet pour ne pas l'attendre ici). */
async function openRequest(): Promise<{ answer: Promise<boolean> }> {
  const answer = ensureHealthDataConsent();
  for (let i = 0; i < 20 && !dialog(); i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  return { answer };
}

describe('HealthDataConsentHost', () => {
  it('fermée tant que rien n’est demandé', () => {
    expect(dialog()).toBeNull();
  });

  it('explique les données, la finalité, le lieu, la durée et le retrait', async () => {
    const { answer: pending } = await openRequest();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('fréquence cardiaque');
    expect(text).toContain('Calibrer la prédiction');
    expect(text).toContain('serveurs de RedView');
    expect(text).toContain('Tant que le projet existe');
    expect(text).toContain('Compte → Vos données');
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    act(() => buttonByText('Refuser')!.click());
    await expect(pending).resolves.toBe(false);
  });

  it('« Refuser » : faux, pop-in fermée, rien d’enregistré', async () => {
    const { answer: pending } = await openRequest();
    act(() => buttonByText('Refuser')!.click());
    await expect(pending).resolves.toBe(false);
    expect(dialog()).toBeNull();
    expect(state.user.prefs.healthDataConsent).toBeUndefined();
  });

  it('Échap vaut refus', async () => {
    const { answer: pending } = await openRequest();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await expect(pending).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it('« J’accepte » : vrai, accord enregistré dans le compte', async () => {
    const { answer: pending } = await openRequest();
    await act(async () => {
      buttonByText('J’accepte')!.click();
      await pending;
    });
    await expect(pending).resolves.toBe(true);
    expect(state.user.prefs.healthDataConsent).toMatchObject({ version: 1 });
  });
});
