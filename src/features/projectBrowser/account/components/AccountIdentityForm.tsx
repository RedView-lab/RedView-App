import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import { AccountSection } from './AccountSection';
import type { AccountIdentityForm as AccountIdentityFormValue } from '../types';

type AccountIdentityFormProps = {
  value: AccountIdentityFormValue;
  initialValue: AccountIdentityFormValue;
  isSaving: boolean;
  onChange: (next: AccountIdentityFormValue) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function AccountIdentityForm({
  value,
  initialValue,
  isSaving,
  onChange,
  onCancel,
  onSave,
}: AccountIdentityFormProps) {
  const isDirty =
    value.firstName !== initialValue.firstName ||
    value.lastName !== initialValue.lastName ||
    value.email !== initialValue.email;
  const { t } = useAppI18n();
  const isDisabled =
    isSaving || !isDirty || !value.firstName.trim() || !value.lastName.trim() || !value.email.trim();

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
          <input
            type="email"
            value={value.email}
            onChange={(event) =>
              onChange({
                ...value,
                email: event.target.value,
              })
            }
          />
        </span>
      </label>

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