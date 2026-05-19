import {
  IconClose,
  IconSave,
  IconSettingsCog,
  IconDownload,
  IconShare,
} from '../icons';
import { useAppI18n } from '@/shared/i18n';

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
  onRename,
  onSettings,
  onDownload,
  onShare,
}: PanelHeaderProps) {
  const { locale, t } = useAppI18n();
  const privacyLabel = privacy === 'private' ? t('Privé') : t('Public');
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
          </div>
        </div>
      </div>
      <div className="rvi-header__actions">
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onSettings}
          aria-label={t('Paramètres du projet')}
        >
          <IconSettingsCog size={16} />
        </button>
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onDownload}
          aria-label={t('Télécharger')}
          aria-disabled={!savedAt}
        >
          <IconDownload size={16} />
        </button>
        <button
          type="button"
          className="rvi-iconbtn"
          onClick={onShare}
          aria-label={t('Partager')}
          aria-disabled={!savedAt}
        >
          <IconShare size={16} />
        </button>
      </div>
    </header>
  );
}
