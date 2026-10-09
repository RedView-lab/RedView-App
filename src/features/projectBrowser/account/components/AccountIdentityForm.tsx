import { useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import { AccountSection } from './AccountSection';
import { ChangeEmailDialog } from './ChangeEmailDialog';
import type { AccountIdentityForm as AccountIdentityFormValue } from '../types';

type AccountIdentityFormProps = {
  value: AccountIdentityFormValue;
  initialValue: AccountIdentityFormValue;
  isSaving: boolean;
  /** Le compte a un mot de passe : exigé par Appwrite pour changer d'adresse. */
  hasPassword: boolean;
  onChange: (next: AccountIdentityFormValue) => void;
  onCancel: () => void;
  onSave: () => void;
  /** Adresse changée (vérifiée par code) : le profil la reprend. */
  onEmailChanged: (email: string) => void;
};

export function AccountIdentityForm({
  value,
  initialValue,
  isSaving,
  hasPassword,
  onChange,
  onCancel,
  onSave,
  onEmailChanged,
}: AccountIdentityFormProps) {
  const [changeEmailAnchor, setChangeEmailAnchor] = useState<HTMLElement | null>(null);
  const isDirty =
    value.firstName !== initialValue.firstName ||
    value.lastName !== initialValue.lastName;
  const { t } = useAppI18n();
  const isDisabled =
    isSaving || !isDirty || !value.firstName.trim() || !value.lastName.trim();

  return (
    <AccountSection title={t('Coordonnees')}>
      <div className="rvpb-account-fields rvpb-account-fields--two-up">
        <label className="rvpb-account-field">
          <span className="rvpb-account-field__label">{t('First name *')}</span>
          <span className="rvpb-account-input-shell">
            <input
              type="text"
              value={value.firstName}
              onChange={(event) =>
                onChange({
                  ...value,
                  firstName: event.target.value,
                })
              }
            />
          </span>
        </label>

        <label className="rvpb-account-field">
          <span className="rvpb-account-field__label">{t('Last name *')}</span>
          <span className="rvpb-account-input-shell">
            <input
              type="text"
              value={value.lastName}
              onChange={(event) =>
                onChange({
                  ...value,
                  lastName: event.target.value,
                })
              }
            />
          </span>
        </label>
      </div>

      <label className="rvpb-account-field">
        <span className="rvpb-account-field__label">{t('Email address *')}</span>
        <span className="rvpb-account-input-shell rvpb-account-input-shell--with-icon">
          <span className="rvpb-account-input-icon">
            <SvgV2Icon name="mail-02.svg" size={16} />
          </span>
          {/* Adresse de connexion : se change par la pop-in (mot de passe +
              code envoyé à la nouvelle adresse), jamais par ce champ. */}
          <input
            type="email"
            value={value.email}
            readOnly
            aria-describedby="rvpb-account-email-hint"
          />
        </span>
      </label>
      <div className="rvpb-account-actions">
        <span id="rvpb-account-email-hint" className="rvpb-account-inline-status">
          {hasPassword
            ? t('Adresse de connexion du compte.')
            : t('Pour changer d’adresse, définissez d’abord un mot de passe (section Mot de passe).')}
        </span>
        {hasPassword ? (
          <button type="button" className="rvpb-inline-cta" onClick={(event) => setChangeEmailAnchor(event.currentTarget)}>
            {t('Changer d’adresse')}
          </button>
        ) : null}
      </div>
      {changeEmailAnchor ? (
        <ChangeEmailDialog
          currentEmail={initialValue.email}
          anchorEl={changeEmailAnchor}
          onChanged={(email) => {
            setChangeEmailAnchor(null);
            onEmailChanged(email);
          }}
          onClose={() => setChangeEmailAnchor(null)}
        />
      ) : null}

      <div className="rvpb-account-actions rvpb-account-actions--with-divider">
        <button
          type="button"
          className="rvpb-inline-cta"
          onClick={onCancel}
          disabled={isSaving || !isDirty}
        >
          {t('Annuler')}
        </button>
        <button type="button" className="rvpb-inline-cta is-danger" onClick={onSave} disabled={isDisabled}>
          {isSaving ? t('Enregistrement...') : t('Enregistrer')}
        </button>
      </div>
    </AccountSection>
  );
}