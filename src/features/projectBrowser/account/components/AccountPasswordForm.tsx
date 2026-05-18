import { AccountSection } from './AccountSection';
import { useAppI18n } from '@/shared/i18n';

type AccountPasswordFormProps = {
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function AccountPasswordForm({ value, isSaving, onChange, onSave }: AccountPasswordFormProps) {
  const { t } = useAppI18n();

  return (
    <AccountSection title={t('Mot de passe')}>
      <div className="rvpb-account-password-row">
        <div className="rvpb-account-password-label">{t('Current password *')}</div>

        <div className="rvpb-account-password-form">
          <label className="rvpb-account-field">
            <span className="rvpb-sr-only">{t('Current password')}</span>
            <span className="rvpb-account-input-shell">
              <input
                type="password"
                autoComplete="new-password"
                value={value}
                onChange={(event) => onChange(event.target.value)}
              />
            </span>
          </label>

          <div className="rvpb-account-actions">
            <button
              type="button"
              className="rvpb-inline-cta is-danger"
              onClick={onSave}
              disabled={isSaving || value.trim().length < 8}
            >
              {isSaving ? t('Mise a jour...') : t('Changer le mot de passe')}
            </button>
          </div>
        </div>
      </div>
    </AccountSection>
  );
}