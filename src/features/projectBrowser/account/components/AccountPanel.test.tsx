// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import type { AccountProfile } from '../types';

/**
 * Onglet Compte : la pratique s'enregistre seule (500 ms après une
 * modification), les coordonnées par leur bouton. Un enregistrement d'une
 * section ne doit jamais effacer une saisie en cours dans l'autre, ni ramener
 * un profil périmé.
 */

const saves = vi.hoisted(() => ({
  practice: [] as Array<{ resolve: () => void; form: unknown }>,
  identity: vi.fn(async (form: { email: string }) => ({ email: form.email })),
}));

vi.mock('../lib/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/profile')>()),
  saveAccountPractice: (form: unknown) => new Promise<void>((resolve) => saves.practice.push({ resolve, form })),
  saveAccountIdentity: saves.identity,
}));
// Section « Vos données » : lit l'accord .fit du compte, hors sujet ici.
vi.mock('./AccountDataForm', () => ({ AccountDataForm: () => null }));

const { AccountPanel } = await import('./AccountPanel');

const PROFILE: AccountProfile = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  country: 'FR',
  sports: [{ id: 'sport-1', sport: 'cycling', level: 'intermediate', annualDistanceKm: '500' }],
  lastSignInAt: null,
  hasPassword: true,
};

/** Profils publiés par le panneau. */
const onPublished = vi.fn<(profile: AccountProfile) => void>();
const published = () => onPublished.mock.lastCall?.[0] ?? PROFILE;

/** Le parent garde le profil publié, comme ProjectBrowserOverlay. */
function Harness() {
  const [profile, setProfile] = useState<AccountProfile>(PROFILE);
  return createElement(AccountPanel, {
    profile,
    isLoading: false,
    error: null,
    fallbackDisplayName: 'Ada',
    onProfileUpdated: (next: AccountProfile) => {
      onPublished(next);
      setProfile(next);
    },
  });
}

let view: RenderedComponent | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  saves.practice.length = 0;
  saves.identity.mockClear();
  onPublished.mockClear();
  view = renderComponent(createElement(Harness));
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const firstNameInput = () => view!.container.querySelectorAll<HTMLInputElement>('input[type="text"]')[0]!;

async function finishPracticeSave() {
  act(() => { vi.advanceTimersByTime(500); });
  expect(saves.practice).toHaveLength(1);
  await act(async () => {
    saves.practice[0]!.resolve();
    await Promise.resolve();
  });
}

describe('AccountPanel', () => {
  it('l’enregistrement de la pratique garde le prénom tapé mais pas encore enregistré', async () => {
    type(firstNameInput(), 'Grace');
    view!.click(view!.button('Ajouter un sport'));
    await finishPracticeSave();
    expect(published().sports).toHaveLength(2);
    expect(firstNameInput().value).toBe('Grace');
  });

  it('coordonnées enregistrées pendant l’enregistrement de la pratique : aucune ne revient en arrière', async () => {
    view!.click(view!.button('Ajouter un sport'));
    act(() => { vi.advanceTimersByTime(500); });
    type(firstNameInput(), 'Grace');
    await act(async () => {
      view!.button('Enregistrer').click();
      await Promise.resolve();
    });
    expect(published().firstName).toBe('Grace');
    await act(async () => {
      saves.practice[0]!.resolve();
      await Promise.resolve();
    });
    expect(published().firstName).toBe('Grace');
    expect(published().sports).toHaveLength(2);
    expect(firstNameInput().value).toBe('Grace');
  });
});
