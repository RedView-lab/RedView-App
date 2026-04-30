import { AccountSection } from './AccountSection';

type AccountPasswordFormProps = {
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function AccountPasswordForm({ value, isSaving, onChange, onSave }: AccountPasswordFormProps) {
  return (
    <AccountSection title="Mot de passe">
      <div className="rvpb-account-password-row">
        <div className="rvpb-account-password-label">Current password *</div>

        <div className="rvpb-account-password-form">
          <label className="rvpb-account-field">
            <span className="rvpb-sr-only">Current password</span>
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
              {isSaving ? 'Mise a jour...' : 'Changer le mot de passe'}
            </button>
          </div>
        </div>
      </div>
    </AccountSection>
  );
}