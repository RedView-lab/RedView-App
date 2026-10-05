import {
  cancelFlyoverVideoExport,
  dismissFlyoverVideoExport,
  useFlyoverVideoExport,
} from '@/features/centerPanel/flyover';
import { useAppI18n } from '@/shared/i18n';

import { IconX } from '../icons';

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Avancement de l'export vidéo du flyover : barre, image en cours, temps
 * restant, annulation ; puis le résultat. L'état vit hors du panneau (le
 * rendu continue s'il est replié ou démonté).
 */
export function VideoExportStatus() {
  const { t } = useAppI18n();
  const state = useFlyoverVideoExport();

  const formatDuration = (seconds: number): string => {
    const total = Math.max(1, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes === 0) return t('{{seconds}} s', { seconds: rest });
    return rest === 0 ? t('{{minutes}} min', { minutes }) : t('{{minutes}} min {{seconds}} s', { minutes, seconds: rest });
  };

  if (state.status === 'idle') return null;

  if (state.status === 'running') {
    const percent = Math.min(100, Math.max(0, Math.floor(state.fraction * 100)));
    const title = state.orientation === 'portrait' ? t('Vidéo verticale 9:16') : t('Vidéo horizontale 16:9');
    const detail =
      state.phase === 'preparing'
        ? t('Préparation de la carte…')
        : state.phase === 'finalizing'
          ? t('Finalisation du fichier…')
          : t('Rendu : image {{frame}} / {{total}}', { frame: state.frame, total: state.totalFrames });
    return (
      <div className="rvc-exporter-video" role="status" aria-live="polite">
        <div className="rvc-exporter-video__head">
          <span className="rvc-exporter-video__title">{title}</span>
          <span className="rvc-exporter-video__percent">{`${percent} %`}</span>
        </div>
        <div
          className="rvc-exporter-video__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="rvc-exporter-video__fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="rvc-exporter-video__detail">
          <span>{detail}</span>
          {state.etaS != null ? <span>{t('Environ {{time}} restantes', { time: formatDuration(state.etaS) })}</span> : null}
        </div>
        {state.videoDurationS != null ? (
          <div className="rvc-exporter-video__detail">
            <span>{t('Durée de la vidéo : {{duration}}', { duration: formatClock(state.videoDurationS) })}</span>
          </div>
        ) : null}
        <button type="button" className="rvc-exporter-video__cancel" onClick={cancelFlyoverVideoExport}>
          <IconX size={12} />
          <span>{t('Annuler le rendu')}</span>
        </button>
      </div>
    );
  }

  const tone = state.status === 'done' ? 'success' : state.status === 'error' ? 'error' : 'idle';
  const message =
    state.status === 'done'
      ? `${t('Vidéo exportée : {{file}} ({{size}}, {{duration}})', {
          file: state.fileName,
          size: t('{{size}} Mo', { size: (state.sizeBytes / 1_048_576).toFixed(state.sizeBytes < 10_485_760 ? 1 : 0) }),
          duration: formatClock(state.durationS),
        })} ${t('Rendu en {{time}}.', { time: formatDuration(state.elapsedS) })}`
      : state.status === 'error'
        ? t(state.message)
        : t('Rendu de la vidéo annulé.');
  return (
    <div className={`rvc-exporter-video__result is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      <button type="button" className="rvc-exporter-video__dismiss" onClick={dismissFlyoverVideoExport} aria-label={t('Fermer')}>
        <IconX size={10} />
      </button>
    </div>
  );
}
