import { SvgV2Icon } from '@/components/SvgV2Icon';

import {
  ACCOUNT_COUNTRY_OPTIONS,
  ACCOUNT_LEVEL_OPTIONS,
  ACCOUNT_SPORT_OPTIONS,
} from './options';
import { AccountSection } from './AccountSection';
import type { AccountPracticeForm as AccountPracticeFormValue } from './types';

type AccountPracticeFormProps = {
  value: AccountPracticeFormValue;
  isSaving: boolean;
  onChange: (next: AccountPracticeFormValue) => void;
  onAddSport: () => void;
};

function findCountryStyle(countryCode: string) {
  return ACCOUNT_COUNTRY_OPTIONS.find((option) => option.value === countryCode)?.flag;
}

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
        <span className="rvpb-account-select-shell">
          <span className="rvpb-account-flag" style={{ background: countryFlag }} aria-hidden="true" />
          <select
            value={value.country}
            onChange={(event) =>
              onChange({
                ...value,
                country: event.target.value,
              })
            }
          >
            {ACCOUNT_COUNTRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="rvpb-account-select-icon">
            <SvgV2Icon name="chevron-down.svg" size={16} />
          </span>
        </span>
      </label>

      {value.sports.map((sport, index) => (
        <div key={sport.id} className="rvpb-account-fields rvpb-account-fields--three-up">
          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">Sport {index + 1}</span>
            <span className="rvpb-account-select-shell">
              <select
                value={sport.sport}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sports: value.sports.map((entry) =>
                      entry.id === sport.id ? { ...entry, sport: event.target.value } : entry,
                    ),
                  })
                }
              >
                {ACCOUNT_SPORT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <span className="rvpb-account-select-icon">
                <SvgV2Icon name="chevron-down.svg" size={16} />
              </span>
            </span>
          </label>

          <label className="rvpb-account-field">
            <span className="rvpb-account-field__label">Level</span>
            <span className="rvpb-account-select-shell">
              <select
                value={sport.level}
                onChange={(event) =>
                  onChange({
                    ...value,
                    sports: value.sports.map((entry) =>
                      entry.id === sport.id ? { ...entry, level: event.target.value } : entry,
                    ),
                  })
                }
              >
                {ACCOUNT_LEVEL_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <span className="rvpb-account-select-icon">
                <SvgV2Icon name="chevron-down.svg" size={16} />
              </span>
            </span>
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