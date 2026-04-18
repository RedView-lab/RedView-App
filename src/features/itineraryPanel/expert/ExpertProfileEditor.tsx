/**
 * Expert Mode editor — full-screen modal that lists every BRouter
 * parameter exposed by `ALL_PARAMETERS`, grouped by topic.
 *
 * Killer feature angle:
 *   - 100 % client-side: the moment the user moves a slider, the next
 *     route request goes out with the corresponding `profile:xxx`
 *     override. No round-trip to upload anything.
 *   - Every parameter is documented in French.
 *   - "Afficher tous les paramètres" reveals the advanced knobs.
 *   - Live BRF preview & copy-to-clipboard for power users.
 *   - Reset / Reset-all buttons.
 *   - Optional raw-BRF text editor + "Téléverser" → uses the
 *     `uploadCustomProfile()` endpoint for full control.
 */
import { useEffect, useRef, useState } from 'react';
import { ALL_PARAMETERS } from './parameters';
import { PARAMETER_GROUPS, type ExpertProfileState, type ParameterValue } from './types';
import { ParamGroup } from './components/ParamGroup';
import { BrfPreview } from './components/BrfPreview';
import { createDefaultExpertValues } from './defaults';
import { IconClose } from '../components/icons';

interface ExpertProfileEditorProps {
  open: boolean;
  state: ExpertProfileState;
  onChange: (next: ExpertProfileState) => void;
  onClose: () => void;
}

export function ExpertProfileEditor({
  open,
  state,
  onChange,
  onClose,
}: ExpertProfileEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  }, [open]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handle = () => onClose();
    dlg.addEventListener('close', handle);
    return () => dlg.removeEventListener('close', handle);
  }, [onClose]);

  const handleBackdrop = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose();
  };

  const updateValue = (id: string, value: ParameterValue) => {
    onChange({
      ...state,
      enabled: true,
      values: { ...state.values, [id]: value },
    });
  };

  const resetValue = (id: string) => {
    const param = ALL_PARAMETERS.find((p) => p.id === id);
    if (!param) return;
    updateValue(id, param.default);
  };

  const resetAll = () => {
    onChange({
      ...state,
      values: createDefaultExpertValues(),
    });
  };

  const toggleEnabled = () => {
    onChange({ ...state, enabled: !state.enabled });
  };

  const changedCount = ALL_PARAMETERS.reduce((acc, p) => {
    const v = state.values[p.id];
    if (v === undefined) return acc;
    if (typeof v === 'number' && typeof p.default === 'number') {
      return acc + (Math.abs(v - p.default) > 1e-6 ? 1 : 0);
    }
    return acc + (v !== p.default ? 1 : 0);
  }, 0);

  return (
    <dialog
      ref={dialogRef}
      className="rvi-dialog rvi-expert-dialog"
      onClick={handleBackdrop}
      aria-labelledby="rvi-expert-title"
    >
      <div
        className="rvi-dialog__panel rvi-expert-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rvi-dialog__head">
          <div>
            <h2 id="rvi-expert-title" className="rvi-dialog__title">
              Mode Expert — profil BRouter sur-mesure
            </h2>
            <p className="rvi-expert-sub">
              Ajustez chaque paramètre du moteur de routage. Tout reste local
              à votre navigateur ; les changements s’appliquent au prochain
              calcul d’itinéraire.
            </p>
          </div>
          <button
            type="button"
            className="rvi-dialog__close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="rvi-expert-toolbar">
          <label className="rvi-expert-toolbar__enable">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={toggleEnabled}
            />
            <span>Activer Mode Expert</span>
            {state.enabled ? (
              <span className="rvi-expert-toolbar__badge">
                {changedCount} modif{changedCount > 1 ? 's' : ''}
              </span>
            ) : null}
          </label>

          <label className="rvi-expert-toolbar__advanced">
            <input
              type="checkbox"
              checked={showAdvanced}
              onChange={(e) => setShowAdvanced(e.target.checked)}
            />
            <span>Afficher tous les paramètres</span>
          </label>

          <button
            type="button"
            className="rvi-expert-toolbar__btn"
            onClick={resetAll}
            disabled={changedCount === 0}
          >
            Tout réinitialiser
          </button>

          <button
            type="button"
            className="rvi-expert-toolbar__btn"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? 'Masquer BRF' : 'Voir BRF'}
          </button>
        </div>

        <div className="rvi-expert-body">
          <div className="rvi-expert-groups">
            {PARAMETER_GROUPS.map((g) => (
              <ParamGroup
                key={g.id}
                meta={g}
                params={ALL_PARAMETERS}
                values={state.values}
                showAdvanced={showAdvanced}
                onChange={updateValue}
                onReset={resetValue}
              />
            ))}
          </div>

          {showPreview ? (
            <aside className="rvi-expert-aside">
              <BrfPreview state={state} />
            </aside>
          ) : null}
        </div>

        <footer className="rvi-expert-footer">
          <span className="rvi-expert-footer__hint">
            Astuce : tout est calculé côté client. Vos profils ne quittent
            jamais votre navigateur, sauf si vous cliquez sur « Téléverser »
            (à venir) pour les utiliser sur d’autres appareils.
          </span>
          <button
            type="button"
            className="rvi-expert-footer__close"
            onClick={onClose}
          >
            Fermer
          </button>
        </footer>
      </div>
    </dialog>
  );
}
