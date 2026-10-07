/**
 * Partage d'un projet, comme dans Figma : on invite une personne par son
 * e-mail (compte RedView existant), elle modifie le projet avec vous en temps
 * réel. Le propriétaire voit qui a accès et peut retirer quelqu'un ; un
 * éditeur peut quitter le projet.
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css),
 * rendue en portal : l'échelle du canevas est relue sur l'élément déclencheur.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconClose, IconShare } from '@/features/itineraryPanel/components/icons';
import { UserAvatar } from '@/shared/components/UserAvatar/UserAvatar';
import { useAppI18n } from '@/shared/i18n';
import { appScaleStyle, readAppScale } from '@/shared/lib/appScale';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { notify } from '@/shared/lib/notify';

import {
  useInviteProjectEditor,
  useLeaveSharedProject,
  useProjectShare,
  useRemoveProjectEditor,
} from '../../queries/projectSharing';

import './ShareProjectDialog.css';

type ShareProjectDialogProps = {
  projectId: string;
  projectName: string;
  /** Projet d'un autre propriétaire (avant la réponse du serveur). */
  sharedWithMe?: boolean;
  /** Élément déclencheur : échelle du canevas, et focus rendu à la fermeture. */
  anchorEl: HTMLElement | null;
  userId: string | null;
  onClose: () => void;
  /**
   * Avant la première invitation : le dernier état du projet part au cloud
   * (le serveur temps réel ouvrira la salle à partir de ce document).
   */
  onBeforeFirstShare?: () => Promise<void>;
  /** Première personne invitée : le projet devient partagé (session temps réel). */
  onShared?: () => void;
  /** L'utilisateur a quitté le projet. */
  onLeft?: () => void;
};

export function ShareProjectDialog({
  projectId,
  projectName,
  sharedWithMe = false,
  anchorEl,
  userId,
  onClose,
  onBeforeFirstShare,
  onShared,
  onLeft,
}: ShareProjectDialogProps) {
  const { t } = useAppI18n();
  const share = useProjectShare(projectId);
  const invite = useInviteProjectEditor(userId);
  const remove = useRemoveProjectEditor(userId);
  const leave = useLeaveSharedProject(userId);
  const [email, setEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const isOwner = share.data?.isOwner ?? !sharedWithMe;
  const members = share.data?.members ?? [];

  useEffect(() => {
    trackAnalyticsEvent({ name: 'share_dialog_opened' });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const focusHandle = window.requestAnimationFrame(() => (inputRef.current ?? closeRef.current)?.focus());
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(focusHandle);
      anchorEl?.focus();
    };
  }, [anchorEl, onClose]);

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value || invite.isPending) return;
    setInviteError(null);
    const wasShared = share.data?.shared ?? false;
    try {
      if (!wasShared) await onBeforeFirstShare?.();
      const state = await invite.mutateAsync({ id: projectId, email: value });
      trackAnalyticsEvent({ name: 'share_invite_sent' });
      setEmail('');
      notify.success('{{email}} peut maintenant modifier ce projet.', { email: value });
      if (!wasShared && state.shared) onShared?.();
    } catch (error) {
      trackAnalyticsEvent({ name: 'share_invite_failed' });
      setInviteError(error instanceof Error ? error.message : t('Le partage du projet a échoué.'));
    }
  };

  const leaveProject = async () => {
    if (!window.confirm(t('Quitter « {{name}} » ? Vous n’y aurez plus accès.', { name: projectName }))) return;
    try {
      await leave.mutateAsync({ id: projectId });
      onClose();
      onLeft?.();
    } catch {
      // Toast du MutationCache.
    }
  };

  const scale = readAppScale(anchorEl);

  return createPortal(
    <div className="rv-dialog" role="presentation" onMouseDown={onClose}>
      <div
        className="rv-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-share-dialog-title"
        style={appScaleStyle(scale)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rv-dialog__header">
          <span className="rv-dialog__badge" aria-hidden>
            <IconShare size={16} />
          </span>
          <div className="rv-dialog__heading">
            <h2 id="rv-share-dialog-title" className="rv-dialog__title rv-share-dialog__title">
              {t('Partager « {{name}} »', { name: projectName })}
            </h2>
            <p className="rv-dialog__subtitle">
              {isOwner
                ? t('Invitez un compte RedView par e-mail : il modifie le projet avec vous, en temps réel.')
                : t('Vous modifiez ce projet avec ces personnes, en temps réel.')}
            </p>
          </div>
          <button ref={closeRef} type="button" className="rv-dialog__close" aria-label={t('Fermer')} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="rv-dialog__body">
          {isOwner ? (
            <form className="rv-share-dialog__invite" onSubmit={(event) => void submitInvite(event)}>
              <input
                ref={inputRef}
                className="rv-share-dialog__input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={t('Adresse e-mail')}
                aria-label={t('Adresse e-mail de la personne à inviter')}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setInviteError(null);
                }}
                disabled={invite.isPending}
              />
              <button
                type="submit"
                className="rv-dialog__btn rv-dialog__btn--primary"
                disabled={invite.isPending || !email.trim()}
              >
                {invite.isPending ? t('Invitation…') : t('Inviter')}
              </button>
            </form>
          ) : null}
          {inviteError ? (
            <div className="rv-share-dialog__error" role="alert">
              {inviteError}
            </div>
          ) : null}

          <section className="rv-dialog__section">
            <div className="rv-dialog__section-title">{t('Personnes ayant accès')}</div>
            {share.isLoading ? (
              <div className="rv-share-dialog__empty">{t('Chargement…')}</div>
            ) : share.error ? (
              <div className="rv-share-dialog__error" role="alert">
                {share.error.message}
              </div>
            ) : members.length === 0 ? (
              <div className="rv-share-dialog__empty">{t('Seulement vous pour l’instant.')}</div>
            ) : (
              <ul className="rv-share-dialog__people">
                {members.map((member) => {
                  const label = member.name || member.email;
                  return (
                    <li key={member.userId} className="rv-share-dialog__person">
                      <UserAvatar userId={member.userId} name={label} />
                      <span className="rv-share-dialog__person-text">
                        <span className="rv-share-dialog__person-name">
                          {label}
                          {member.userId === userId ? <span className="rv-share-dialog__you"> {t('(vous)')}</span> : null}
                        </span>
                        {member.name ? <span className="rv-share-dialog__person-email">{member.email}</span> : null}
                      </span>
                      <span className="rv-share-dialog__role">
                        {member.role === 'owner' ? t('Propriétaire') : t('Peut modifier')}
                      </span>
                      {isOwner && member.role === 'editor' ? (
                        <button
                          type="button"
                          className="rv-dialog__close rv-share-dialog__remove"
                          aria-label={t('Retirer l’accès à {{name}}', { name: label })}
                          title={t('Retirer l’accès')}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ id: projectId, memberId: member.userId })}
                        >
                          <IconClose size={14} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="rv-dialog__footer">
          {!isOwner ? (
            <button
              type="button"
              className="rv-dialog__btn rv-share-dialog__leave"
              onClick={() => void leaveProject()}
              disabled={leave.isPending}
            >
              {t('Quitter le projet')}
            </button>
          ) : null}
          <button type="button" className="rv-dialog__btn" onClick={onClose}>
            {t('Terminé')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
