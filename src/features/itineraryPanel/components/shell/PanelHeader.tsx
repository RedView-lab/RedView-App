import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  IconClose,
  IconSave,
  IconShare,
} from '../icons';
import { UserAvatarStack, type StackPerson } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';
import type { CollaboratorAction, ProjectCollaborator, ProjectSaveStatus, ProjectSessionStatus } from '../../types';
import { CollaboratorMenu } from './CollaboratorMenu';

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
  /** Pastilles cliquables (comme Figma) : suivre un éditeur, présenter sa vue (sa propre pastille). */
  onCollaboratorAction?: (userId: string, action: CollaboratorAction) => void;
  /** Session de co-édition (absent hors session) : connexion lente ou coupée signalée sous le titre. */
  sessionStatus?: ProjectSessionStatus;
}

/** Places de la pile d'éditeurs (la dernière devient « +N » au-delà) : panneau large / étroit. */
const COLLABORATOR_SLOTS = { full: 4, compact: 2 } as const;

/** Signalée seulement si elle dure : une connexion normale (≈ 1 s) ou une reconnexion rapide n'affiche rien. */
const SESSION_STATUS_DELAY_MS = { connecting: 1200, offline: 2000 } as const;

function useLastingSessionStatus(status: ProjectSessionStatus | undefined): 'connecting' | 'offline' | null {
  const [lasting, setLasting] = useState<ProjectSessionStatus | undefined>(undefined);
  useEffect(() => {
    const delay = status === 'connecting' || status === 'offline' ? SESSION_STATUS_DELAY_MS[status] : 0;
    const timer = window.setTimeout(() => setLasting(delay > 0 ? status : undefined), delay);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (status === 'connecting' || status === 'offline') && lasting === status ? status : null;
}

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
  onCollaboratorAction,
  sessionStatus,
}: PanelHeaderProps) {
  const { locale, t } = useAppI18n();
  const lastingSessionStatus = useLastingSessionStatus(sessionStatus);
  const [menu, setMenu] = useState<{ people: ProjectCollaborator[]; anchor: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Infobulle de chaque pastille : ce qu'un clic fait (suivre, arrêter, présenter).
  const stackPeople = useMemo<StackPerson[]>(() => collaborators.map((person) => {
    let title: string;
    if (person.isSelf) {
      title = person.followed ? t('Vous présentez votre vue') : t('Vous : présenter ma vue');
    } else if (person.followed) {
      title = t('Arrêter de suivre {{name}}', { name: person.name });
    } else if (person.presenting) {
      title = t('{{name}} présente sa vue : le suivre', { name: person.name });
    } else {
      title = person.followsMe ? t('Suivre {{name}} (vous suit)', { name: person.name }) : t('Suivre {{name}}', { name: person.name });
    }
    const ring = person.followed && !person.isSelf ? 'followed' : person.presenting || (person.isSelf && person.followed) ? 'presenting' : null;
    return { userId: person.userId, name: person.name, ring, title };
  }), [collaborators, t]);

  const handlePersonClick = useCallback((person: StackPerson, anchor: HTMLElement) => {
    if (!onCollaboratorAction) return;
    const collaborator = collaborators.find((candidate) => candidate.userId === person.userId);
    if (!collaborator) return;
    if (collaborator.isSelf) {
      setMenu((current) => (current?.anchor === anchor ? null : { people: [collaborator], anchor }));
      return;
    }
    onCollaboratorAction(collaborator.userId, collaborator.followed ? 'unfollow' : 'follow');
  }, [collaborators, onCollaboratorAction]);

  const handleMoreClick = useCallback((hidden: readonly StackPerson[], anchor: HTMLElement) => {
    const ids = new Set(hidden.map((person) => person.userId));
    const people = collaborators.filter((person) => ids.has(person.userId));
    setMenu((current) => (current?.anchor === anchor ? null : { people, anchor }));
  }, [collaborators]);
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
    <header className="rvi-header" data-rv-collab-status={sessionStatus}>
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
            {lastingSessionStatus ? (
              <span
                className="rvi-header__sync-message is-pending"
                role="status"
                title={t('Vos modifications sont gardées sur cet appareil et partiront dès la connexion.')}
              >
                {lastingSessionStatus === 'connecting'
                  ? t('Connexion à la session…')
                  : t('Hors ligne : vos modifications partiront à la reconnexion.')}
              </span>
            ) : saveStatusMessage && (saveStatus === 'error' || saveStatus === 'pending') ? (
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
              {/* Panneau large : 4 places ; étroit : 2. */}
              <UserAvatarStack
                people={stackPeople}
                max={COLLABORATOR_SLOTS.full}
                className="rvi-header__people-full"
                onPersonClick={onCollaboratorAction ? handlePersonClick : undefined}
                onMoreClick={onCollaboratorAction ? handleMoreClick : undefined}
              />
              <UserAvatarStack
                people={stackPeople}
                max={COLLABORATOR_SLOTS.compact}
                className="rvi-header__people-compact"
                onPersonClick={onCollaboratorAction ? handlePersonClick : undefined}
                onMoreClick={onCollaboratorAction ? handleMoreClick : undefined}
              />
            </div>
          ) : null}
          {menu && onCollaboratorAction ? (
            <CollaboratorMenu people={menu.people} anchorEl={menu.anchor} onAction={onCollaboratorAction} onClose={closeMenu} />
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
