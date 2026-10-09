import { AccountSection } from './AccountSection';
import { useAppI18n } from '@/shared/i18n';

import { passwordFormProblem, type AccountPasswordValue } from '../lib/passwordForm';

type AccountPasswordFormProps = {
  value: AccountPasswordValue;
  /** Compte avec mot de passe : l'actuel est exigé (Appwrite) ; un compte Google en crée un. */
  hasPassword: boolean;
  isSaving: boolean;
  onChange: (value: AccountPasswordValue) => void;
  onSave: () => void;
};

export function AccountPasswordForm({ value, hasPassword, isSaving, onChange, onSave }: AccountPasswordFormProps) {
  const { t } = useAppI18n();
  const problem = passwordFormProblem(value, hasPassword);
  // Le message n'apparaît qu'une fois la confirmation commencée (pas d'erreur dès la première touche).
  const visibleProblem = problem && value.confirm ? problem : null;

  return (
    <AccountSection title={t('Mot de passe')}>
      <form
        className="rvpb-account-password-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem && !isSaving) onSave();
        }}
      >
        {hasPassword ? (
          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">{t('Mot de passe actuel')}</span>
            <span className="rvpb-account-input-shell">
              <input
                type="password"
                autoComplete="current-password"
                value={value.current}
                onChange={(event) => onChange({ ...value, current: event.target.value })}
              />
            </span>
          </label>
        ) : (
          <p className="rvpb-account-data-hint">
            {t('Vous vous connectez avec Google : un mot de passe vous permettra aussi de vous connecter par e-mail.')}
          </p>
        )}

        <div className="rvpb-account-fields rvpb-account-fields--two-up">
          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">{t('Nouveau mot de passe')}</span>
            <span className="rvpb-account-input-shell">
              <input
                type="password"
                autoComplete="new-password"
                value={value.next}
                onChange={(event) => onChange({ ...value, next: event.target.value })}
              />
            </span>
          </label>

          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">{t('Confirmer le nouveau mot de passe')}</span>
            <span className="rvpb-account-input-shell">
              <input
                type="password"
                autoComplete="new-password"
                value={value.confirm}
                aria-invalid={visibleProblem ? true : undefined}
                onChange={(event) => onChange({ ...value, confirm: event.target.value })}
              />
            </span>
          </label>
        </div>

        <div className="rvpb-account-actions">
          {visibleProblem ? (
            <span className="rvpb-account-inline-status" role="status">
              {t(visibleProblem)}
            </span>
          ) : null}
          <button type="submit" className="rvpb-inline-cta is-danger" disabled={isSaving || problem !== null}>
            {isSaving ? t('Mise à jour…') : t('Changer le mot de passe')}
          </button>
        </div>
      </form>
    </AccountSection>
  );
}
