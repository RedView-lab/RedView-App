/**
 * Modal dialog opened when the user clicks "Nouvel itinéraire".
 *
 * Two large choice tiles:
 *   1. "Créer de zéro"        → simply emits `onPickScratch`.
 *   2. "Importer depuis GPX"  → opens the OS file picker; on selection, the
 *      file is forwarded to `onPickGpx(file)` so the container can parse it
 *      and create the matching itinerary.
 *
 * The dialog uses native `<dialog>` semantics with a glassmorphism backdrop,
 * keyboard-traps focus inside (browser default), and closes on Escape or on
 * backdrop click.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { IconClose, IconSparkles, IconUploadCloud } from './icons';

interface AddItineraryDialogProps {
  open: boolean;
  onClose: () => void;
  onPickScratch: () => void;
  onPickGpx: (file: File) => Promise<void> | void;
}

export function AddItineraryDialog({
  open,
  onClose,
  onPickScratch,
  onPickGpx,
}: AddItineraryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      setError(null);
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Native <dialog> emits "close" on Escape — propagate it to parent.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const handleClose = () => onClose();
    dlg.addEventListener('close', handleClose);
    return () => dlg.removeEventListener('close', handleClose);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose();
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.gpx')) {
      setError('Veuillez sélectionner un fichier .gpx');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onPickGpx(file);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de lire ce GPX');
    } finally {
      setLoading(false);
    }
  };

  const handleScratch = () => {
    onPickScratch();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="rvi-dialog"
      onClick={handleBackdropClick}
      aria-labelledby="rvi-add-itin-title"
    >
      <div className="rvi-dialog__panel" onClick={(e) => e.stopPropagation()}>
        <header className="rvi-dialog__head">
          <h2 id="rvi-add-itin-title" className="rvi-dialog__title">
            Nouvel itinéraire
          </h2>
          <button
            type="button"
            className="rvi-dialog__close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <IconClose size={14} />
          </button>
        </header>

        <p className="rvi-dialog__sub">
          Comment souhaitez-vous démarrer&nbsp;?
        </p>

        <div className="rvi-add-itin-grid">
          <button
            type="button"
            className="rvi-add-itin-tile"
            onClick={handleScratch}
            disabled={loading}
          >
            <span className="rvi-add-itin-tile__icon">
              <IconSparkles size={28} />
            </span>
            <span className="rvi-add-itin-tile__title">Créer de zéro</span>
            <span className="rvi-add-itin-tile__desc">
              Trace ton parcours étape par étape avec les outils RedView.
            </span>
          </button>

          <label
            className={`rvi-add-itin-tile rvi-add-itin-tile--gpx${
              loading ? ' is-loading' : ''
            }`}
          >
            <span className="rvi-add-itin-tile__icon">
              <IconUploadCloud size={28} />
            </span>
            <span className="rvi-add-itin-tile__title">
              {loading ? 'Lecture du GPX…' : 'Importer un GPX'}
            </span>
            <span className="rvi-add-itin-tile__desc">
              Charge un fichier .gpx existant pour générer l’itinéraire et
              lancer automatiquement la recherche de POI.
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gpx,application/gpx+xml,application/xml,text/xml"
              onChange={handleFileChange}
              disabled={loading}
              hidden
            />
          </label>
        </div>

        {error ? (
          <p className="rvi-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
