// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { passwordFormProblem, type AccountPasswordValue } from '../lib/passwordForm';
import { AccountPasswordForm } from './AccountPasswordForm';

/**
 * Changement de mot de passe : l'actuel est demandé quand le compte en a un
 * (Appwrite l'exige), le nouveau est confirmé ; un compte Google en crée un.
 */

const value = (current: string, next: string, confirm = next): AccountPasswordValue => ({ current, next, confirm });

describe('passwordFormProblem', () => {
  it('compte avec mot de passe : actuel exigé, nouveau confirmé et différent', () => {
    expect(passwordFormProblem(value('', 'nouveau-123'), true)).toBe('Saisissez votre mot de passe actuel.');
    expect(passwordFormProblem(value('ancien-123', 'court'), true)).toBe('Le mot de passe doit comporter au moins 8 caractères.');
    expect(passwordFormProblem(value('ancien-123', 'nouveau-123', 'nouveau-124'), true)).toBe('Les mots de passe ne correspondent pas.');
    expect(passwordFormProblem(value('ancien-123', 'ancien-123'), true)).toBe('Le nouveau mot de passe doit être différent de l’actuel.');
    expect(passwordFormProblem(value('ancien-123', 'x'.repeat(257)), true)).toBe('Le mot de passe ne doit pas dépasser 256 caractères.');
    expect(passwordFormProblem(value('ancien-123', 'nouveau-123'), true)).toBeNull();
  });

  it('compte Google : pas d’actuel à saisir', () => {
    expect(passwordFormProblem(value('', 'nouveau-123'), false)).toBeNull();
  });
});

describe('AccountPasswordForm', () => {
  let view: RenderedComponent | null = null;
  afterEach(() => {
    view?.unmount();
    view = null;
  });

  const labels = () => [...view!.container.querySelectorAll('.rvpb-account-field__label')].map((node) => node.textContent);

  it('compte avec mot de passe : trois champs, envoi seulement quand la saisie est valable', () => {
    const onSave = vi.fn();
    const render = (current: AccountPasswordValue) =>
      createElement(AccountPasswordForm, { value: current, hasPassword: true, isSaving: false, onChange: () => {}, onSave });
    view = renderComponent(render(value('', '')));
    expect(labels()).toEqual(['Mot de passe actuel', 'Nouveau mot de passe', 'Confirmer le nouveau mot de passe']);
    expect(view.button('Changer le mot de passe').disabled).toBe(true);

    view.rerender(render(value('ancien-123', 'nouveau-123', 'nouveau-12')));
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Les mots de passe ne correspondent pas.');
    expect(view.button('Changer le mot de passe').disabled).toBe(true);

    view.rerender(render(value('ancien-123', 'nouveau-123')));
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    const submit = view.button('Changer le mot de passe');
    expect(submit.disabled).toBe(false);
    view.click(submit);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('compte Google : pas de champ « actuel », une explication à la place', () => {
    view = renderComponent(
      createElement(AccountPasswordForm, { value: value('', ''), hasPassword: false, isSaving: false, onChange: () => {}, onSave: () => {} }),
    );
    expect(labels()).toEqual(['Nouveau mot de passe', 'Confirmer le nouveau mot de passe']);
    expect(view.container.textContent).toContain('Vous vous connectez avec Google');
  });
});
