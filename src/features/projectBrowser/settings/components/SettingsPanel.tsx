import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  resolveAppLocale,
  type AppLocale,
  useAppI18n,
} from '@/shared/i18n';
import { AccountSelect, type AccountSelectOption } from '../../account/components/AccountSelect';
import { LANDING_URL } from '../../lib';

type DisplayMode = 'system' | 'light' | 'dark';
type UnitSetting = 'metric' | 'imperial';
type MapPresetSetting = 'day' | 'night';

type SettingsState = {
  language: AppLocale;
  unit: UnitSetting;
  mapPreset: MapPresetSetting;
  displayMode: DisplayMode;
  communityPromptEnabled: boolean;
};

type SettingsSelectProps = {
  label: string;
  value: string;
  options: readonly AccountSelectOption[];
  onChange: (value: string) => void;
  renderValuePrefix?: (option: AccountSelectOption | undefined) => ReactNode;
  renderOptionPrefix?: (option: AccountSelectOption) => ReactNode;
};

type DisplayOption = {
  id: DisplayMode;
  label: string;
  imageSrc: string;
};

const DISPLAY_OPTION_ASSETS = [
  {
    id: 'system' as const,
    imageSrc: '/project-browser/settings/display-system.png',
  },
  {
    id: 'light' as const,
    imageSrc: '/project-browser/settings/display-light.png',
  },
  {
    id: 'dark' as const,
    imageSrc: '/project-browser/settings/display-dark.png',
  },
];

function createDefaultSettings(language: AppLocale): SettingsState {
  return {
    language,
    unit: 'metric',
    mapPreset: 'day',
    displayMode: 'system',
    communityPromptEnabled: true,
  };
}

function isUnitSetting(value: unknown): value is UnitSetting {
  return value === 'metric' || value === 'imperial';
}

function isMapPresetSetting(value: unknown): value is MapPresetSetting {
  return value === 'day' || value === 'night';
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function resolveStoredUnit(value: unknown): UnitSetting {
  if (value === 'Pieds' || value === 'imperial') return 'imperial';
  return 'metric';
}

function resolveStoredMapPreset(value: unknown): MapPresetSetting {
  if (value === 'Nuit' || value === 'night') return 'night';
  return 'day';
}

function readStoredSettings(fallbackLanguage: AppLocale): SettingsState {
  const defaults = createDefaultSettings(fallbackLanguage);

  if (typeof window === 'undefined') {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;

    const parsed = JSON.parse(raw) as Partial<SettingsState>;

    return {
      language: resolveAppLocale(parsed.language ?? fallbackLanguage),
      unit: isUnitSetting(parsed.unit) ? parsed.unit : resolveStoredUnit(parsed.unit),
      mapPreset: isMapPresetSetting(parsed.mapPreset) ? parsed.mapPreset : resolveStoredMapPreset(parsed.mapPreset),
      displayMode: isDisplayMode(parsed.displayMode) ? parsed.displayMode : defaults.displayMode,
      communityPromptEnabled:
        typeof parsed.communityPromptEnabled === 'boolean'
          ? parsed.communityPromptEnabled
          : defaults.communityPromptEnabled,
    };
  } catch {
    return defaults;
  }
}

function PlayCircleIcon() {
  return (
    <svg aria-hidden="true" className="rvpb-settings-feedback__chip-icon" fill="none" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.2 6.9L13.1 10L8.2 13.1V6.9Z" fill="currentColor" />
    </svg>
  );
}

function renderFlag(option: AccountSelectOption | undefined) {
  if (!option?.flag) return null;

  return (
    <span className="rvpb-account-flag" aria-hidden="true">
      <img
        className="rvpb-account-flag__image"
        src={option.flag}
        alt=""
        loading="lazy"
      />
    </span>
  );
}

function SettingsSelect({
  label,
  value,
  options,
  onChange,
  renderValuePrefix,
  renderOptionPrefix,
}: SettingsSelectProps) {
  return (
    <div className="rvpb-settings-select">
      <AccountSelect
        ariaLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        renderValuePrefix={renderValuePrefix}
        renderOptionPrefix={renderOptionPrefix}
      />
    </div>
  );
}

function buildFeedbackHref() {
  return `${LANDING_URL.replace(/\/$/, '')}/formulaire`;
}

export function SettingsPanel() {
  const { locale, setLocale, t } = useAppI18n();
  const [settings, setSettings] = useState<SettingsState>(() => readStoredSettings(locale));

  const languageSelectOptions = useMemo<AccountSelectOption[]>(
    () => APP_LOCALE_OPTIONS.map((option) => ({ ...option })),
    [],
  );
  const unitSelectOptions = useMemo<AccountSelectOption[]>(
    () => [
      { value: 'metric', label: t('Mètre') },
      { value: 'imperial', label: t('Pieds') },
    ],
    [t],
  );
  const mapPresetSelectOptions = useMemo<AccountSelectOption[]>(
    () => [
      { value: 'day', label: t('Jour (nuit couché de soleil)') },
      { value: 'night', label: t('Nuit') },
    ],
    [t],
  );
  const displayOptions = useMemo<DisplayOption[]>(
    () => [
      { ...DISPLAY_OPTION_ASSETS[0], label: t('System preference') },
      { ...DISPLAY_OPTION_ASSETS[1], label: t('Light mode') },
      { ...DISPLAY_OPTION_ASSETS[2], label: t('Dark mode') },
    ],
    [t],
  );
  const feedbackDescription = t(
    "RedView s'appuie sur de nombreuses rencontres, discussions et observations réalisées avec la communauté cycliste. Si vous voulez contribuer au développement de l'outil, vous pouvez utiliser notre questionnaire de feedback ci-dessous.",
  );

  useEffect(() => {
    setSettings((current) => (current.language === locale ? current : { ...current, language: locale }));
  }, [locale]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Best effort only.
    }
  }, [settings]);

  return (
    <section className="rvpb-settings-panel" aria-label={t('Réglages globaux')}>
      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">{t('Langue')}</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label={t('Langue')}
            value={settings.language}
            options={languageSelectOptions}
            onChange={(language) => {
              const nextLocale = resolveAppLocale(language);
              setSettings((current) => ({ ...current, language: nextLocale }));
              setLocale(nextLocale);
            }}
            renderValuePrefix={renderFlag}
            renderOptionPrefix={renderFlag}
          />
        </div>
      </div>

      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">{t('Unité de mesure')}</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label={t('Unité de mesure')}
            value={settings.unit}
            options={unitSelectOptions}
            onChange={(unit) =>
              setSettings((current) => ({
                ...current,
                unit: unit === 'imperial' ? 'imperial' : 'metric',
              }))
            }
          />
        </div>
      </div>

      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">{t('Paramètre de carte')}</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label={t('Paramètre de carte')}
            value={settings.mapPreset}
            options={mapPresetSelectOptions}
            onChange={(mapPreset) =>
              setSettings((current) => ({
                ...current,
                mapPreset: mapPreset === 'night' ? 'night' : 'day',
              }))
            }
          />
        </div>
      </div>

      <div className="rvpb-divider" />

      <div className="rvpb-settings-row rvpb-settings-row--display">
        <div className="rvpb-settings-row__label">{t('Préférence d’affichage')}</div>
        <div className="rvpb-settings-display-options" role="radiogroup" aria-label={t('Préférence d’affichage')}>
          {displayOptions.map((option) => {
            const isSelected = settings.displayMode === option.id;

            return (
              <button
                key={option.id}
                type="button"
                className={`rvpb-settings-display-card${isSelected ? ' is-selected' : ''}`}
                role="radio"
                aria-checked={isSelected}
                onClick={() => setSettings((current) => ({ ...current, displayMode: option.id }))}
              >
                <span className="rvpb-settings-display-card__preview">
                  <img src={option.imageSrc} alt="" loading="lazy" />
                  {isSelected ? <span className="rvpb-settings-display-card__marker" aria-hidden="true" /> : null}
                </span>
                <span className="rvpb-settings-display-card__label">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rvpb-settings-row rvpb-settings-row--toggle">
        <div className="rvpb-settings-row__label">{t('Réglage')}</div>
        <div className="rvpb-settings-row__control">
          <button
            type="button"
            className={`rvpb-settings-switch${settings.communityPromptEnabled ? ' is-on' : ''}`}
            role="switch"
            aria-checked={settings.communityPromptEnabled}
            aria-label={t('Activer le réglage')}
            onClick={() =>
              setSettings((current) => ({
                ...current,
                communityPromptEnabled: !current.communityPromptEnabled,
              }))
            }
          >
            <span className="rvpb-settings-switch__thumb" />
          </button>
        </div>
      </div>

      <div className="rvpb-settings-feedback">
        <article className="rvpb-settings-feedback__title-card">
          <h2>{t('Construit avec et pour la communauté')}</h2>
        </article>

        <article className="rvpb-settings-feedback__body-card">
          <p>{feedbackDescription}</p>

          <a
            className="rvpb-settings-feedback__chip"
            href={buildFeedbackHref()}
            rel="noreferrer"
            target="_blank"
          >
            <PlayCircleIcon />
            <span>{t('Notre questionnaire de feedback')}</span>
          </a>
        </article>
      </div>
    </section>
  );
}