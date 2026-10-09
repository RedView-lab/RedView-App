import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  resolveAppLocale,
  type AppLocale,
  useAppI18n,
} from '@/shared/i18n';
import { AccountSelect, type AccountSelectOption } from '../../account/components/AccountSelect';
import type { AccountProfile } from '../../account';
import { readStoredAppwriteSession } from '@/shared/services/appwrite';
import {
  DEFAULT_APP_THEME_PREFERENCE,
  isAppThemePreference,
  setAppThemePreference,
  type AppThemePreference,
} from '@/shared/lib/appTheme';
import { LANDING_URL } from '../../lib';
import { DataSourcesSection } from './DataSourcesSection';

type DisplayMode = AppThemePreference;
/**
 * Réglages du navigateur. « Unité de mesure », « Paramètre de carte » et
 * l'interrupteur « Réglage » ont été retirés le 2026-10-09 : enregistrés mais
 * lus nulle part (les distances sont formatées en km dans ~80 fichiers ; un
 * vrai mode impérial est un chantier à part). Les anciennes clés stockées sont
 * ignorées et disparaissent à la prochaine écriture.
 */
type SettingsState = {
  language: AppLocale;
  displayMode: DisplayMode;
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
    imageSrc: '/images/settings/display-system.png',
  },
  {
    id: 'light' as const,
    imageSrc: '/images/settings/display-light.png',
  },
  {
    id: 'dark' as const,
    imageSrc: '/images/settings/display-dark.png',
  },
];

function createDefaultSettings(language: AppLocale): SettingsState {
  return {
    language,
    displayMode: DEFAULT_APP_THEME_PREFERENCE,
  };
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
      displayMode: isAppThemePreference(parsed.displayMode) ? parsed.displayMode : defaults.displayMode,
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

function buildFeedbackHref(profile?: AccountProfile | null) {
  const base = `${LANDING_URL.replace(/\/$/, '')}/`;
  const params = new URLSearchParams();
  params.set('feedback', 'open');
  params.set('step', '1');

  const sessionUser = readStoredAppwriteSession()?.user;
  const email = profile?.email || sessionUser?.email || '';
  const firstName =
    profile?.firstName || (sessionUser?.name ? sessionUser.name.split(' ')[0] : '');
  const lastName =
    profile?.lastName ||
    (sessionUser?.name ? sessionUser.name.split(' ').slice(1).join(' ') : '');
  const country = profile?.country || '';

  if (email) params.set('email', email);
  if (firstName) params.set('firstName', firstName);
  if (lastName) params.set('lastName', lastName);
  if (country) params.set('country', country);

  return `${base}?${params.toString()}`;
}

export type SettingsPanelProps = {
  profile?: AccountProfile | null;
};

export function SettingsPanel({ profile }: SettingsPanelProps = {}) {
  const { locale, setLocale, t } = useAppI18n();
  const [settings, setSettings] = useState<SettingsState>(() => readStoredSettings(locale));

  const languageSelectOptions = useMemo<AccountSelectOption[]>(
    () => APP_LOCALE_OPTIONS.map((option) => ({ ...option })),
    [],
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

  // La langue des réglages suit celle de l'app : à l'ouverture et quand elle
  // change (autre onglet, autre écran).
  const [settingsLocale, setSettingsLocale] = useState<AppLocale | null>(null);
  if (settingsLocale !== locale) {
    setSettingsLocale(locale);
    setSettings((current) => (current.language === locale ? current : { ...current, language: locale }));
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Au mieux seulement.
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
              trackAnalyticsEvent({ name: 'language_changed', data: { language: nextLocale } });
            }}
            renderValuePrefix={renderFlag}
            renderOptionPrefix={renderFlag}
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
                onClick={() => {
                  setSettings((current) => ({ ...current, displayMode: option.id }));
                  setAppThemePreference(option.id);
                  trackAnalyticsEvent({ name: 'theme_changed', data: { mode: option.id } });
                }}
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

      <div className="rvpb-settings-feedback">
        <article className="rvpb-settings-feedback__title-card">
          <h2>{t('Construit avec et pour la communauté')}</h2>
        </article>

        <article className="rvpb-settings-feedback__body-card">
          <p>{feedbackDescription}</p>

          <a
            className="rvpb-settings-feedback__chip"
            href={buildFeedbackHref(profile)}
            rel="noreferrer"
            target="_blank"
          >
            <PlayCircleIcon />
            <span>{t('Notre questionnaire de feedback')}</span>
          </a>
        </article>
      </div>

      <div className="rvpb-divider" />

      <DataSourcesSection />
    </section>
  );
}