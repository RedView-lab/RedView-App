import { Fragment, memo } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { ChartSlopeOverlay } from './buildSlopeColorRuns';
import { SLOPE_COLOR_CLASSES } from './slopeScale';

interface SlopeLegendProps {
  overlay: ChartSlopeOverlay;
  itineraryName?: string;
}

function formatKm(distanceM: number, locale: string): string {
  const km = distanceM / 1000;
  const digits = km < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km)} km`;
}

/**
 * Légende de la colorisation « Pente » sur une ligne : descente et plat en
 * retrait, puis les montées avec la distance parcourue dans chaque classe.
 * Les classes absentes restent affichées, atténuées, pour que la mise en page
 * ne saute pas d'un itinéraire à l'autre.
 */
export const SlopeLegend = memo(function SlopeLegend({ overlay, itineraryName }: SlopeLegendProps) {
  const { t, locale } = useAppI18n();
  const { distributionM, totalM } = overlay;
  if (!(totalM > 0)) return null;

  return (
    <div className="rvchart-slope-legend" aria-label={t('Répartition des pentes')}>
      <span className="rvchart-slope-legend__title" title={itineraryName}>
        {t('Pente')}
      </span>
      <div className="rvchart-slope-legend__items">
        {SLOPE_COLOR_CLASSES.map((entry, index) => {
          const distanceM = distributionM[index] ?? 0;
          const percent = Math.round((distanceM / totalM) * 100);
          const label = entry.climb ? entry.label : t(entry.label);
          const firstClimb = entry.climb && !SLOPE_COLOR_CLASSES[index - 1]?.climb;
          const className = [
            'rvchart-slope-legend__item',
            entry.climb ? '' : 'is-calm',
            distanceM > 0 ? '' : 'is-empty',
          ].filter(Boolean).join(' ');
          return (
            <Fragment key={entry.id}>
              {firstClimb ? <span className="rvchart-slope-legend__divider" aria-hidden="true" /> : null}
              <span className={className} title={`${label} · ${formatKm(distanceM, locale)} · ${percent} %`}>
                <span className="rvchart-slope-legend__swatch" style={{ background: entry.color }} aria-hidden="true" />
                <span className="rvchart-slope-legend__label">{label}</span>
                <span className="rvchart-slope-legend__value">{formatKm(distanceM, locale)}</span>
              </span>
            </Fragment>
          );
        })}
      </div>
      <span className="rvchart-slope-legend__hint">
        {t('Pente moyenne par tronçon · zoomez pour le détail')}
      </span>
    </div>
  );
});
