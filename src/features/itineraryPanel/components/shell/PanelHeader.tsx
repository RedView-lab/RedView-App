import {
  IconClose,
  IconSave,
  IconSettingsCog,
  IconDownload,
  IconShare,
} from '../icons';

interface PanelHeaderProps {
  title: string;
  savedAt: string | null;
  sizeBytes: number | null;
  privacy: 'private' | 'public';
  onBack?: () => void;
  backDisabled?: boolean;
  onRename?: (next: string) => void;
  onSettings?: () => void;
  onDownload?: () => void;
  onShare?: () => void;
}

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(
    2,
  )} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}ko`;
  return `${Math.round(bytes / (1024 * 1024))}mo`;
}

export function PanelHeader({
  title,
  savedAt,
  sizeBytes,
  privacy,
  onBack,
  backDisabled = false,
  onRename,
  onSettings,
  onDownload,
  onShare,
}: PanelHeaderProps) {
  const privacyLabel = privacy === 'private' ? 'Privé' : 'Public';
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
          aria-label={backDisabled ? 'Retour au gestionnaire en cours' : 'Retour au gestionnaire de projet'}
          title={backDisabled ? 'Retour au gestionnaire en cours' : 'Retour au gestionnaire de projet'}
        >
          <IconClose size={18} />
        </button>
        <div className="rvi-header__info">
          <input
            className="rvi-header__title"
            value={title}
            onChange={(e) => onRename?.(e.target.value)}
            placeholder="Nouveau projet"
            aria-label="Nom du projet"
          />
          <div className="rvi-header__meta">
            <span className="rvi-header__badge">{privacyLabel}</span>
            {savedAt ? (
              <span className="rvi-header__saved">
                <IconSave size={14} />
                <span>{formatSavedAt(savedAt)}</span>
              </span>
            ) : (
              <span className="rvi-header__saved" title="Projet non enregistré">
                <IconSave size={14} />
                <span>Non enregistré</span>
              </span>
            )}
            {sizeBytes !== null ? (
              <span className="rvi-header__size">{formatSize(sizeBytes)}</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="rvi-header__actions">
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onSettings}
          aria-label="Paramètres du projet"
        >
          <IconSettingsCog size={16} />
        </button>
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onDownload}
          aria-label="Télécharger"
          aria-disabled={!savedAt}
        >
          <IconDownload size={16} />
        </button>
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onShare}
          aria-label="Partager"
          aria-disabled={!savedAt}
        >
          <IconShare size={16} />
        </button>
      </div>
    </header>
  );
}
