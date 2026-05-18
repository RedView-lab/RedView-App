import { useMemo } from 'react';

import { useAppI18n } from '@/shared/i18n';

import {
  ACCOUNT_LEVEL_OPTIONS,
  ACCOUNT_SPORT_OPTIONS,
  buildAccountCountryOptions,
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

const COUNTRY_FLAG_BASE_PATH = '/landing/svg';

function findCountryOption(countryCode: string, options: readonly AccountSelectOption[]) {
  return options.find((option) => option.value === countryCode);
}

function CountryFlag({ option }: { option?: AccountSelectOption }) {
  if (!option?.flagCode) {
    return <span className="rvpb-account-flag rvpb-account-flag--fallback" aria-hidden="true" />;
  }

  return (
    <span className="rvpb-account-flag" aria-hidden="true">
      <img
        className="rvpb-account-flag__image"
        src={`${COUNTRY_FLAG_BASE_PATH}/${option.flagCode}.svg`}
        alt=""
        loading="lazy"
      />
    </span>
  );
}

export function AccountPracticeForm({
  value,
  isSaving,
  onChange,
  onAddSport,
}: AccountPracticeFormProps) {
  const { locale, t } = useAppI18n();
  const countryOptions = useMemo(() => buildAccountCountryOptions(locale), [locale]);
  const sportOptions: AccountSelectOption[] = useMemo(
    () =>
      ACCOUNT_SPORT_OPTIONS.map((option) => ({
        value: option,
        label: t(option),
      })),
    [t],
  );
  const levelOptions: AccountSelectOption[] = useMemo(
    () =>
      ACCOUNT_LEVEL_OPTIONS.map((option) => ({
        value: option,
        label: t(option),
      })),
    [t],
  );
  const selectedCountryOption = findCountryOption(value.country, countryOptions) ?? countryOptions[0];

  return (
    <AccountSection title={t('Pratique')}>
      <label className="rvpb-account-field">
        <span className="rvpb-account-field__label">{t('Pays')}</span>
        <AccountSelect
          value={value.country}
          options={countryOptions}
          renderValuePrefix={(selectedOption: AccountSelectOption | undefined) => (
            <CountryFlag option={selectedOption ?? selectedCountryOption} />
          )}
          renderOptionPrefix={(option: AccountSelectOption) => <CountryFlag option={option} />}
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
            <span className="rvpb-account-field__label">{`${t('Sport')} ${index + 1}`}</span>
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
            <span className="rvpb-account-field__label">{t('Level')}</span>
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
            <span className="rvpb-account-field__label">{t('Moyenne annuelle')}</span>
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
        <span className="rvpb-account-inline-status">{isSaving ? t('Enregistrement...') : ' '}</span>
        <button type="button" className="rvpb-inline-cta is-danger" onClick={onAddSport}>
          {t('Ajouter un sport')}
        </button>
      </div>
    </AccountSection>
  );
}