/**
 * Pop-ins de confirmation et de saisie (`confirmDialog` / `promptDialog`,
 * shared/lib/appDialog.ts). Rendu dans l'app par `AppDialogGate` (chargé à la
 * demande), dans le visualiseur LiDAR par `mountStandaloneAppDialogHost`.
 *
 * Pop-in commune de l'application (`.rv-dialog`, shared/styles/dialog.css).
 * Les touches tapées dedans ne remontent pas à la page : Échap ferme cette
 * pop-in seulement (pas le partage ni le gestionnaire de projets dessous), et
 * aucun raccourci de la carte ne part pendant la saisie d'un nom.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { useAppI18n } from '@/shared/i18n';
import { answerAppDialog, getCurrentAppDialog, subscribeAppDialog, type AppDialogRequest } from '@/shared/lib/appDialog';
import { appScaleStyle, readRootAppScale } from '@/shared/lib/appScale';
import { trapFocus } from '@/shared/lib/focusTrap';

import './AppDialogHost.css';

export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialog, getCurrentAppDialog, () => null);
  return request ? <AppDialog key={request.id} request={request} /> : null;
}

function AppDialog({ request }: { request: AppDialogRequest }) {
  const { t } = useAppI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.kind === 'prompt' ? request.options.initialValue ?? '' : '');
  const { id, kind, options } = request;
  const titleId = `rv-app-dialog-${id}-title`;
  const messageId = `rv-app-dialog-${id}-message`;
  const message = kind === 'confirm' ? options.message : undefined;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const cancel = () => answerAppDialog(id, kind === 'confirm' ? false : null);
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Tab') {
        trapFocus(event, overlay);
      }
    };
    // Échap quand le focus n'est pas (encore) dans la pop-in.
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || overlay.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    overlay.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onWindowKeyDown, true);
    const focusHandle = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      } else {
        // Le bouton sans conséquence : Entrée par réflexe n'efface rien.
        cancelRef.current?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(focusHandle);
      overlay.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onWindowKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [id, kind]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'confirm') {
      answerAppDialog(id, true);
      return;
    }
    const text = value.trim();
    if (text) answerAppDialog(id, text);
  };
  const cancelValue = kind === 'confirm' ? false : null;

  return createPortal(
    <div ref={overlayRef} className="rv-dialog" role="presentation" onMouseDown={() => answerAppDialog(id, cancelValue)}>
      <div
        className="rv-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        tabIndex={-1}
        style={appScaleStyle(readRootAppScale())}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form className="rv-app-dialog__form" onSubmit={submit}>
          <header className="rv-dialog__header">
            <div className="rv-dialog__heading">
              <h2 id={titleId} className="rv-dialog__title">{options.title}</h2>
            </div>
          </header>
          <div className="rv-dialog__body">
            {message ? <p id={messageId} className="rv-app-dialog__text">{message}</p> : null}
            {kind === 'prompt' ? (
              <label className="rv-dialog__section">
                <span className="rv-dialog__section-title">{options.label}</span>
                <input
                  ref={inputRef}
                  className="rv-app-dialog__input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={options.maxLength}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <footer className="rv-dialog__footer">
            <button ref={cancelRef} type="button" className="rv-dialog__btn" onClick={() => answerAppDialog(id, cancelValue)}>
              {options.cancelLabel ?? t('Annuler')}
            </button>
            <button type="submit" className="rv-dialog__btn rv-dialog__btn--primary" disabled={kind === 'prompt' && !value.trim()}>
              {options.confirmLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
