import { useEffect, useState } from 'react';

import { SvgV2Icon } from '@/shared/components/SvgV2Icon';

import { LANDING_URL } from '../../lib';

type DisplayMode = 'system' | 'light' | 'dark';

type SettingsState = {
  language: string;
  unit: string;
  mapPreset: string;
  displayMode: DisplayMode;
  communityPromptEnabled: boolean;
};

type SettingsSelectProps = {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
};

type DisplayOption = {
  id: DisplayMode;
  label: string;
  imageSrc: string;
};

const STORAGE_KEY = 'redview:project-browser-settings:v1';

const LANGUAGE_OPTIONS = ['English (US)', 'Français'] as const;
const UNIT_OPTIONS = ['Mètre', 'Pieds'] as const;
const MAP_PRESET_OPTIONS = ['Jour (nuit couché de soleil)', 'Nuit'] as const;

const DISPLAY_OPTIONS: DisplayOption[] = [
  {
    id: 'system',
    label: 'System preference',
    imageSrc: '/project-browser/settings/display-system.png',
  },
  {
    id: 'light',
    label: 'Light mode',
    imageSrc: '/project-browser/settings/display-light.png',
  },
  {
    id: 'dark',
    label: 'Dark mode',
    imageSrc: '/project-browser/settings/display-dark.png',
  },
];

const DEFAULT_SETTINGS: SettingsState = {
  language: LANGUAGE_OPTIONS[0],
  unit: UNIT_OPTIONS[0],
  mapPreset: MAP_PRESET_OPTIONS[0],
  displayMode: 'system',
  communityPromptEnabled: true,
};

function isDisplayMode(value: unknown): value is DisplayMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStoredSettings(): SettingsState {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(raw) as Partial<SettingsState>;

    return {
      language: LANGUAGE_OPTIONS.includes(parsed.language as (typeof LANGUAGE_OPTIONS)[number])
        ? parsed.language!
        : DEFAULT_SETTINGS.language,
      unit: UNIT_OPTIONS.includes(parsed.unit as (typeof UNIT_OPTIONS)[number])
        ? parsed.unit!
        : DEFAULT_SETTINGS.unit,
      mapPreset: MAP_PRESET_OPTIONS.includes(parsed.mapPreset as (typeof MAP_PRESET_OPTIONS)[number])
        ? parsed.mapPreset!
        : DEFAULT_SETTINGS.mapPreset,
      displayMode: isDisplayMode(parsed.displayMode) ? parsed.displayMode : DEFAULT_SETTINGS.displayMode,
      communityPromptEnabled:
        typeof parsed.communityPromptEnabled === 'boolean'
          ? parsed.communityPromptEnabled
          : DEFAULT_SETTINGS.communityPromptEnabled,
    };
  } catch {
    return DEFAULT_SETTINGS;
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

function SettingsSelect({ label, value, options, onChange }: SettingsSelectProps) {
  return (
    <label className="rvpb-settings-select" aria-label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span className="rvpb-settings-select__chevron" aria-hidden="true">
        <SvgV2Icon name="chevron-down.svg" size={16} />
      </span>
    </label>
  );
}

function buildFeedbackHref() {
  return `${LANDING_URL.replace(/\/$/, '')}/formulaire`;
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<SettingsState>(readStoredSettings);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Best effort only.
    }
  }, [settings]);

  return (
    <section className="rvpb-settings-panel" aria-label="Réglages globaux">
      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">Langue</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label="Langue"
            value={settings.language}
            options={LANGUAGE_OPTIONS}
            onChange={(language) => setSettings((current) => ({ ...current, language }))}
          />
        </div>
      </div>

      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">Unité de mesure</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label="Unité de mesure"
            value={settings.unit}
            options={UNIT_OPTIONS}
            onChange={(unit) => setSettings((current) => ({ ...current, unit }))}
          />
        </div>
      </div>

      <div className="rvpb-settings-row">
        <div className="rvpb-settings-row__label">Paramètre de carte</div>
        <div className="rvpb-settings-row__control">
          <SettingsSelect
            label="Paramètre de carte"
            value={settings.mapPreset}
            options={MAP_PRESET_OPTIONS}
            onChange={(mapPreset) => setSettings((current) => ({ ...current, mapPreset }))}
          />
        </div>
      </div>

      <div className="rvpb-divider" />

      <div className="rvpb-settings-row rvpb-settings-row--display">
        <div className="rvpb-settings-row__label">Préférence d’affichage</div>
        <div className="rvpb-settings-display-options" role="radiogroup" aria-label="Préférence d’affichage">
          {DISPLAY_OPTIONS.map((option) => {
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
        <div className="rvpb-settings-row__label">Réglage</div>
        <div className="rvpb-settings-row__control">
          <button
            type="button"
            className={`rvpb-settings-switch${settings.communityPromptEnabled ? ' is-on' : ''}`}
            role="switch"
            aria-checked={settings.communityPromptEnabled}
            aria-label="Activer le réglage"
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
          <h2>Construit avec et pour la communauté</h2>
        </article>

        <article className="rvpb-settings-feedback__body-card">
          <p>
            RedView s&apos;appuie sur de nombreuses rencontres, discussions et observations réalisées
            avec la communauté cycliste. Si vous voulez contribuer au développement de l&apos;outil,
            vous pouvez utiliser notre questionnaire de feedback ci-dessous.
          </p>

          <a
            className="rvpb-settings-feedback__chip"
            href={buildFeedbackHref()}
            rel="noreferrer"
            target="_blank"
          >
            <PlayCircleIcon />
            <span>Notre questionnaire de feedback</span>
          </a>
        </article>
      </div>
    </section>
  );
}