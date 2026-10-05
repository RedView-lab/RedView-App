import {
  IconClose,
  IconSave,
  IconShare,
} from '../icons';
import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';
import type { ProjectCollaborator, ProjectSaveStatus } from '../../types';

interface PanelHeaderProps {
  title: string;
  savedAt: string | null;
  sizeBytes: number | null;
  privacy: 'private' | 'public';
  onBack?: () => void;
  backDisabled?: boolean;
  onSave?: () => void;
  saveStatus?: ProjectSaveStatus;
  /** Détail déjà traduit (erreur, attente hors-ligne), affiché en infobulle. */
  saveStatusMessage?: string;
  onRename?: (next: string) => void;
  /** « Partager » (co-édition, comme Figma) : reçoit le bouton (échelle de la pop-in). */
  onShare?: (anchor: HTMLElement) => void;
  /** Éditeurs présents (cet utilisateur compris) : pastilles affichées dès qu'un autre est là. */
  collaborators?: ProjectCollaborator[];
}

/** Pastilles visibles avant « +N ». */
const MAX_VISIBLE_COLLABORATORS = 3;

function formatSavedAt(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: locale === 'fr' ? '2-digit' : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale !== 'fr',
  }).format(d);
}

function formatSize(bytes: number, locale: string): string {
  if (bytes < 1024) return locale === 'fr' ? `${bytes}o` : `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return locale === 'fr' ? `${Math.round(bytes / 1024)}ko` : `${Math.round(bytes / 1024)} KB`;
  }
  return locale === 'fr' ? `${Math.round(bytes / (1024 * 1024))}mo` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function PanelHeader({
  title,
  savedAt,
  sizeBytes,
  privacy,
  onBack,
  backDisabled = false,
  onSave,
  saveStatus = 'idle',
  saveStatusMessage,
  onRename,
  onShare,
  collaborators = [],
}: PanelHeaderProps) {
  const { locale, t } = useAppI18n();
  const privacyLabel = privacy === 'private' ? t('Privé') : t('Public');
  const saveLabel =
    saveStatus === 'saving'
      ? t('Enregistrement…')
      : saveStatus === 'saved'
        ? t('Enregistré')
        : saveStatus === 'pending'
          ? t('Synchronisation en attente')
          : saveStatus === 'error'
            ? t('Échec de l’enregistrement')
            : t('Enregistrer');
  const saveTitle = saveStatusMessage || t('Enregistrer le projet (Ctrl+S)');
  return (
    <header className="rvi-header">
      <div className="rvi-header__title-group">
        <button
          type="button"
          className="rvi-header__back"
          onClick={() => {
            if (backDisabled) return;
            onBack?.();
          }}
          disabled={!onBack || backDisabled}
          aria-label={backDisabled ? t('Retour au gestionnaire en cours') : t('Retour au gestionnaire de projet')}
          title={backDisabled ? t('Retour au gestionnaire en cours') : t('Retour au gestionnaire de projet')}
        >
          <IconClose size={18} />
        </button>
        <div className="rvi-header__info">
          <input
            className="rvi-header__title"
            value={title}
            onChange={(e) => onRename?.(e.target.value)}
            placeholder={t('Nouveau projet')}
            aria-label={t('Nom du projet')}
          />
          <div className="rvi-header__meta">
            <span className="rvi-header__badge">{privacyLabel}</span>
            {savedAt ? (
              <span className="rvi-header__saved">
                <IconSave size={14} />
                <span>{formatSavedAt(savedAt, locale)}</span>
              </span>
            ) : (
              <span className="rvi-header__saved" title={t('Projet non enregistré')}>
                <IconSave size={14} />
                <span>{t('Non enregistré')}</span>
              </span>
            )}
            {sizeBytes !== null ? (
              <span className="rvi-header__size">{formatSize(sizeBytes, locale)}</span>
            ) : null}
            {saveStatusMessage && (saveStatus === 'error' || saveStatus === 'pending') ? (
              <span
                className={`rvi-header__sync-message is-${saveStatus}`}
                role="status"
                title={saveStatusMessage}
              >
                {saveStatusMessage}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {onSave || onShare ? (
        <div className="rvi-header__actions">
          {collaborators.length > 1 ? (
            <div
              className="rvi-header__people"
              role="group"
              aria-label={t('{{count}} éditeurs sur le projet', { count: collaborators.length })}
              title={collaborators.map((collaborator) => collaborator.name).join(', ')}
            >
              {/* Panneau large : jusqu'à 3 pastilles puis « +N » ; étroit : 1 pastille puis « +N ». */}
              <span className="rvi-header__people-full">
                {collaborators.slice(0, MAX_VISIBLE_COLLABORATORS).map((collaborator) => (
                  <UserAvatar key={collaborator.userId} userId={collaborator.userId} name={collaborator.name} ringed />
                ))}
                {collaborators.length > MAX_VISIBLE_COLLABORATORS ? (
                  <span className="rvi-header__people-more">+{collaborators.length - MAX_VISIBLE_COLLABORATORS}</span>
                ) : null}
              </span>
              <span className="rvi-header__people-compact">
                <UserAvatar userId={collaborators[0].userId} name={collaborators[0].name} ringed />
                <span className="rvi-header__people-more">+{collaborators.length - 1}</span>
              </span>
            </div>
          ) : null}
          {onShare ? (
            <button
              type="button"
              className="rvi-header__share"
              onClick={(event) => onShare(event.currentTarget)}
              aria-label={t('Partager le projet')}
              title={t('Partager le projet')}
            >
              <IconShare size={14} />
              <span>{t('Partager')}</span>
            </button>
          ) : null}
          {onSave ? (
            <button
              type="button"
              className={`rvi-header__save is-${saveStatus}`}
              onClick={onSave}
              disabled={saveStatus === 'saving'}
              aria-label={t('Enregistrer le projet')}
              title={saveTitle}
            >
              <IconSave size={14} />
              <span>{saveLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
