import { memo } from 'react';
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
 * Légende de la colorisation « Pente » : barre de répartition proportionnelle
 * puis une pastille par classe avec la distance parcourue dans la classe.
 * Les classes absentes du tracé restent affichées, atténuées, pour que la
 * mise en page ne saute pas d'un itinéraire à l'autre.
 */
export const SlopeLegend = memo(function SlopeLegend({ overlay, itineraryName }: SlopeLegendProps) {
  const { t, locale } = useAppI18n();
  const { distributionM, totalM } = overlay;
  if (!(totalM > 0)) return null;

  return (
    <div className="rvchart-slope-legend" aria-label={t('Répartition des pentes')}>
      <div className="rvchart-slope-legend__bar" aria-hidden="true">
        {SLOPE_COLOR_CLASSES.map((entry, index) => {
          const share = (distributionM[index] ?? 0) / totalM;
          if (share <= 0) return null;
          return (
            <span
              key={entry.id}
              className="rvchart-slope-legend__bar-part"
              style={{ flexGrow: share, background: entry.color }}
            />
          );
        })}
      </div>
      <div className="rvchart-slope-legend__items">
        <span className="rvchart-slope-legend__title" title={itineraryName}>
          {t('Pente')}
        </span>
        {SLOPE_COLOR_CLASSES.map((entry, index) => {
          const distanceM = distributionM[index] ?? 0;
          const percent = Math.round((distanceM / totalM) * 100);
          const label = entry.climb ? entry.label : t(entry.label);
          return (
            <span
              key={entry.id}
              className={`rvchart-slope-legend__item${distanceM > 0 ? '' : ' is-empty'}`}
              title={`${label} · ${formatKm(distanceM, locale)} · ${percent} %`}
            >
              <span className="rvchart-slope-legend__swatch" style={{ background: entry.color }} aria-hidden="true" />
              <span className="rvchart-slope-legend__label">{label}</span>
              <span className="rvchart-slope-legend__value">{formatKm(distanceM, locale)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
});
