import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  IconRedViewMark,
  IconSave,
  IconShare,
} from '../icons';
import { UserAvatarStack, type StackPerson } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';
import { PROJECT_NAME_MAX_LENGTH } from '@/shared/lib/projectName';
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
const COLLABORATOR_SLOTS = { full: 3, compact: 2 } as const;

/** « À l'instant » tant que le dernier enregistrement date de moins d'une minute. */
const JUST_SAVED_MS = 60_000;

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

/** Vrai tant que `savedAt` date de moins de `JUST_SAVED_MS`, puis repasse à faux tout seul. */
function useJustSaved(savedAt: string | null): boolean {
  const savedMs = savedAt ? new Date(savedAt).getTime() : Number.NaN;
  // Horodatage dont la minute est écoulée : un projet rouvert n'affiche jamais « À l'instant ».
  const [expiredFor, setExpiredFor] = useState<number | null>(() =>
    Date.now() - savedMs >= JUST_SAVED_MS ? savedMs : null);
  useEffect(() => {
    if (Number.isNaN(savedMs)) return undefined;
    const delay = Math.max(0, savedMs + JUST_SAVED_MS - Date.now());
    const timer = window.setTimeout(() => setExpiredFor(savedMs), delay);
    return () => window.clearTimeout(timer);
  }, [savedMs]);
  return !Number.isNaN(savedMs) && expiredFor !== savedMs;
}

/** « 09:33 - 09/04/2026 ». */
function formatSavedAt(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const tag = locale === 'fr' ? 'fr-FR' : 'en-US';
  const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: locale !== 'fr' }).format(d);
  const date = new Intl.DateTimeFormat(tag, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  return `${time} - ${date}`;
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
  const justSaved = useJustSaved(savedAt);
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
  const savedText = saveStatus === 'saving'
    ? t('Enregistrement…')
    : !savedAt
      ? t('Non enregistré')
      : justSaved
        ? t('À l’instant')
        : formatSavedAt(savedAt, locale);
  // La taille du projet n'est plus affichée sous le titre : elle reste dans l'infobulle.
  const savedTitle = savedAt
    ? [formatSavedAt(savedAt, locale), sizeBytes !== null ? formatSize(sizeBytes, locale) : null].filter(Boolean).join(' · ')
    : t('Projet non enregistré');
  const backLabel = backDisabled ? t('Retour au gestionnaire en cours') : t('Retour au gestionnaire de projet');
  return (
    <header className="rvi-header" data-rv-collab-status={sessionStatus}>
      <div className="rvi-header__title-group">
        {/* Logo RedView : ramène au gestionnaire de projets. */}
        <button
          type="button"
          className="rvi-header__back"
          onClick={() => {
            if (backDisabled) return;
            onBack?.();
          }}
          disabled={!onBack || backDisabled}
          aria-label={backLabel}
          title={backLabel}
        >
          <IconRedViewMark size={20} />
        </button>
        <div className="rvi-header__info">
          <input
            className="rvi-header__title"
            value={title}
            onChange={(e) => onRename?.(e.target.value)}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            placeholder={t('Nouveau projet')}
            aria-label={t('Nom du projet')}
          />
          <div className="rvi-header__meta">
            {onSave ? (
              <button
                type="button"
                className={`rvi-header__save is-${saveStatus}`}
                onClick={onSave}
                disabled={saveStatus === 'saving'}
                // Icône seule : le nom accessible dit l'état (« Enregistrer », « Enregistré »…).
                aria-label={saveLabel}
                title={saveTitle}
              >
                <IconSave size={20} />
              </button>
            ) : (
              <span className="rvi-header__save" aria-hidden>
                <IconSave size={20} />
              </span>
            )}
            <span className="rvi-header__saved" title={savedTitle}>{savedText}</span>
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
      <div className="rvi-header__actions">
        {/* Projet partagé avec d'autres éditeurs présents : leurs pastilles ; sinon la confidentialité. */}
        {collaborators.length > 1 ? (
          <div
            className="rvi-header__people"
            role="group"
            aria-label={t('{{count}} éditeurs sur le projet', { count: collaborators.length })}
            title={collaborators.map((collaborator) => collaborator.name).join(', ')}
          >
            {/* Panneau large : 3 places ; étroit : 2. */}
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
        ) : (
          <span className="rvi-header__privacy">{privacyLabel}</span>
        )}
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
            <IconShare size={20} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
