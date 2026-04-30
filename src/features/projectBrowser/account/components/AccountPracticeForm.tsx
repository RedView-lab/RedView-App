import {
  ACCOUNT_COUNTRY_OPTIONS,
  ACCOUNT_LEVEL_OPTIONS,
  ACCOUNT_SPORT_OPTIONS,
} from '../lib/options';
import { AccountSelect, type AccountSelectOption } from './AccountSelect';
import { AccountSection } from './AccountSection';
import type { AccountPracticeForm as AccountPracticeFormValue } from '../types';

type AccountPracticeFormProps = {
  value: AccountPracticeFormValue;
  isSaving: boolean;
  onChange: (next: AccountPracticeFormValue) => void;
  onAddSport: () => void;
};

function findCountryStyle(countryCode: string) {
  return ACCOUNT_COUNTRY_OPTIONS.find((option) => option.value === countryCode)?.flag;
}

const sportOptions: AccountSelectOption[] = ACCOUNT_SPORT_OPTIONS.map((option) => ({
  value: option,
  label: option,
}));

const levelOptions: AccountSelectOption[] = ACCOUNT_LEVEL_OPTIONS.map((option) => ({
  value: option,
  label: option,
}));

export function AccountPracticeForm({
  value,
  isSaving,
  onChange,
  onAddSport,
}: AccountPracticeFormProps) {
  const countryFlag = findCountryStyle(value.country) ?? ACCOUNT_COUNTRY_OPTIONS[0].flag;

  return (
    <AccountSection title="Pratique">
      <label className="rvpb-account-field">
        <span className="rvpb-account-field__label">Pays</span>
        <AccountSelect
          value={value.country}
          options={ACCOUNT_COUNTRY_OPTIONS}
          renderValuePrefix={(selectedOption: AccountSelectOption | undefined) => (
            <span
              className="rvpb-account-flag"
              style={{ background: selectedOption?.flag ?? countryFlag }}
              aria-hidden="true"
            />
          )}
          renderOptionPrefix={(option: AccountSelectOption) => (
            <span className="rvpb-account-flag" style={{ background: option.flag ?? countryFlag }} aria-hidden="true" />
          )}
          onChange={(nextCountry: string) =>
            onChange({
              ...value,
              country: nextCountry,
            })
          }
        />
      </label>

      {value.sports.map((sport, index) => (
        <div key={sport.id} className="rvpb-account-fields rvpb-account-fields--three-up">
          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">Sport {index + 1}</span>
            <AccountSelect
              value={sport.sport}
              options={sportOptions}
              onChange={(nextSport: string) =>
                onChange({
                  ...value,
                  sports: value.sports.map((entry) =>
                    entry.id === sport.id ? { ...entry, sport: nextSport } : entry,
                  ),
                })
              }
            />
          </label>

          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">Level</span>
            <AccountSelect
              value={sport.level}
              options={levelOptions}
              onChange={(nextLevel: string) =>
                onChange({
                  ...value,
                  sports: value.sports.map((entry) =>
                    entry.id === sport.id ? { ...entry, level: nextLevel } : entry,
                  ),
                })
              }
            />
          </label>

          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">Moyenne annuelle</span>
            <span className="rvpb-account-input-shell rvpb-account-input-shell--suffix">
              <input
                type="text"
                inputMode="numeric"
                value={sport.annualDistanceKm}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sports: value.sports.map((entry) =>
                      entry.id === sport.id ? { ...entry, annualDistanceKm: event.target.value } : entry,
                    ),
                  })
                }
              />
              <span className="rvpb-account-input-suffix">km</span>
            </span>
          </label>
        </div>
      ))}

      <div className="rvpb-account-actions">
        <span className="rvpb-account-inline-status">{isSaving ? 'Enregistrement...' : ' '}</span>
        <button type="button" className="rvpb-inline-cta is-danger" onClick={onAddSport}>
          Ajouter un sport
        </button>
      </div>
    </AccountSection>
  );
}