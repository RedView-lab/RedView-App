import { useRef, useState, type ReactNode } from 'react';
import { useAppI18n } from '@/shared/i18n';
import {
  IconFigmaChevronDown,
  IconSlidersFigma,
  IconTrashFigma,
} from '../../components/iconsFigma';
import { PortalDropdown } from '../../components/controls/PortalDropdown';
import type { ActivityType } from '../../lib/project/syncTracageParams';
import type { SavedCustomProfile } from '../../lib/project/customProfiles';
import { ACTIVITY_LABELS, BIKE_ACTIVITIES, FOOT_ACTIVITIES } from './activity';
import { ActivityIcon } from './ActivityIcon';

interface ActivitySelectorProps {
  currentActivityName: string;
  currentActivityIcon: ReactNode;
  /** Préset mis en évidence (aucun pendant qu'un profil perso est actif). */
  selectedPresetId: ActivityType | null;
  effectiveBaseId: string;
  savedProfiles: SavedCustomProfile[];
  /** Brouillon de profil non enregistré (réglages modifiés sans profil perso). */
  draftProfileName: string | null;
  onSelectActivity: (activity: ActivityType) => void;
  onSelectCustomProfile: (profile: SavedCustomProfile) => void;
  onDeleteProfile: (id: string) => void;
}

/** Sélecteur « Type d'activité » : présets vélo / à pied, brouillon et profils enregistrés. */
export function ActivitySelector({
  currentActivityName,
  currentActivityIcon,
  selectedPresetId,
  effectiveBaseId,
  savedProfiles,
  draftProfileName,
  onSelectActivity,
  onSelectCustomProfile,
  onDeleteProfile,
}: ActivitySelectorProps) {
  const { t } = useAppI18n();
  const [activityOpen, setActivityOpen] = useState(false);
  const activityBtnRef = useRef<HTMLButtonElement>(null);

  const select = (activity: ActivityType) => {
    onSelectActivity(activity);
    setActivityOpen(false);
  };

  return (
    <div className="rvi-tracage__mode-col">
      <span className="rvi-tracage__label">{t('Type d’activité')}</span>
      <button
        ref={activityBtnRef}
        type="button"
        className="rvi-tracage__mode-btn rvi-tracage__mode-btn--activity"
        onClick={() => setActivityOpen((prev) => !prev)}
        aria-expanded={activityOpen}
        aria-haspopup="listbox"
      >
        <span className="rvi-tracage__mode-btn-icon">
          {currentActivityIcon}
        </span>
        <span className="rvi-tracage__mode-btn-text" title={currentActivityName}>
          {currentActivityName}
        </span>
        <span className={`rvi-tracage__mode-btn-chevron${activityOpen ? ' is-open' : ''}`}>
          <IconFigmaChevronDown size={14} />
        </span>
      </button>

      <PortalDropdown
        open={activityOpen}
        anchorRef={activityBtnRef}
        onClose={() => setActivityOpen(false)}
        minWidth={140}
        align="left"
      >
        {/* Bike presets: Cyclisme sur route, Gravel, VTT */}
        {BIKE_ACTIVITIES.map((activity) => (
          <button
            key={activity}
            type="button"
            className={`rv-dropdown__item${selectedPresetId === activity ? ' is-selected' : ''}`}
            onClick={() => select(activity)}
          >
            <ActivityIcon activity={activity} size={15} />
            <span>{t(ACTIVITY_LABELS[activity])}</span>
          </button>
        ))}

        {/* Foot presets: Running (route) & Trail, on the pedestrian network */}
        <div className="rv-dropdown__divider" />
        {FOOT_ACTIVITIES.map((activity) => (
          <button
            key={activity}
            type="button"
            className={`rv-dropdown__item${selectedPresetId === activity ? ' is-selected' : ''}`}
            onClick={() => select(activity)}
          >
            <ActivityIcon activity={activity} size={15} />
            <span>{t(ACTIVITY_LABELS[activity])}</span>
          </button>
        ))}

        {/* Current in-progress draft profile before saving */}
        {draftProfileName != null && (
          <>
            <div className="rv-dropdown__divider" />
            <button
              type="button"
              className="rv-dropdown__item is-selected"
              onClick={() => setActivityOpen(false)}
            >
              <IconSlidersFigma size={15} />
              <span>{draftProfileName}</span>
            </button>
          </>
        )}

        {/* Saved custom profiles if any */}
        {savedProfiles.length > 0 && (
          <>
            <div className="rv-dropdown__divider" />
            {savedProfiles.map((cp) => (
              <div key={cp.id} className="rvi-tracage__mode-menu-item-row">
                <button
                  type="button"
                  className={`rv-dropdown__item${effectiveBaseId === cp.id ? ' is-selected' : ''}`}
                  onClick={() => {
                    onSelectCustomProfile(cp);
                    setActivityOpen(false);
                  }}
                >
                  <IconSlidersFigma size={15} />
                  <span>{cp.name}</span>
                </button>
                <button
                  type="button"
                  className="rvi-tracage__delete-profile-btn"
                  title={t('Supprimer le profil')}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Supprimer le profil actif rebascule sur un préset : le menu se ferme.
                    if (effectiveBaseId === cp.id) setActivityOpen(false);
                    onDeleteProfile(cp.id);
                  }}
                >
                  <IconTrashFigma size={13} />
                </button>
              </div>
            ))}
          </>
        )}
      </PortalDropdown>
    </div>
  );
}
