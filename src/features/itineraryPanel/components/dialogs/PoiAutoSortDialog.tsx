/**
 * Pop-in du tri automatique des POI : bilan du dernier tri (POI gardés dans
 * la feuille de route, trous non comblés) et critères appliqués.
 *
 * Rendue en portal sur `document.body` : hors du canevas du dashboard
 * (mis à l'échelle par `--app-scale`), on relit l'échelle sur l'ancre pour
 * garder les mêmes proportions que le panneau.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { DEFAULT_AUTO_SORT_RULES } from '@/features/poi/lib/autoSort';
import { useAppI18n } from '@/shared/i18n';

import type { PoiAutoSortSummary } from '../../types';
import {
  IconBakery,
  IconBed,
  IconClose,
  IconDroplet,
  IconFuel,
  IconRoute,
  IconShoppingCart,
  IconSparkles,
  IconUtensils,
} from '../icons';

interface PoiAutoSortDialogProps {
  open: boolean;
  /** Élément déclencheur : sert à lire `--app-scale` et à y rendre le focus. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  summary: PoiAutoSortSummary | null;
  /** Recherche, départ ou rythme modifiés depuis le dernier tri. */
  stale: boolean;
  /** Toggle « Affiner les résultats » éteint : propose de l'activer. */
  onEnable?: () => void;
}

function readAppScale(el: HTMLElement | null): number {
  if (!el) return 1;
  const raw = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--app-scale'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m === 60 ? `${h + 1}h00` : `${h}h${String(m).padStart(2, '0')}`;
}

function formatClock(minutes: number): string {
  return `${Math.floor((minutes / 60) % 24)}h`;
}

export function PoiAutoSortDialog({
  open,
  anchorEl,
  onClose,
  summary,
  stale,
  onEnable,
}: PoiAutoSortDialogProps) {
  const { t } = useAppI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const focusHandle = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(focusHandle);
      anchorEl?.focus();
    };
  }, [anchorEl, onClose, open]);

  if (!open) return null;

  const rules = DEFAULT_AUTO_SORT_RULES;
  const tod = rules.timeOfDay;
  const scale = readAppScale(anchorEl);

  const criteria: Array<{ icon: ReactNode; title: string; detail: string }> = [
    {
      icon: <IconDroplet size={14} />,
      title: t("Eau toutes les {{hours}}h max", { hours: rules.water.maxGapH }),
      detail: t(
        'Fontaines à moins de {{meters}} m, du côté droit de la route, jamais en pleine descente. Un commerce ouvert compte aussi comme recharge.',
        { meters: rules.water.maxLateralM },
      ),
    },
    {
      icon: <IconShoppingCart size={14} />,
      title: t('Ravitaillement toutes les ~{{target}}h ({{max}}h max)', {
        target: rules.resupply.targetGapH,
        max: rules.resupply.maxGapH,
      }),
      detail: t(
        "Commerces ouverts à l'heure de passage prévue, ou dans leurs horaires habituels. Les villages qui regroupent plusieurs commerces sont privilégiés.",
      ),
    },
    {
      icon: <IconBakery size={14} />,
      title: t('Boulangerie le matin ({{from}}–{{to}})', {
        from: formatClock(tod.bakeryMorning.startMin),
        to: formatClock(tod.bakeryMorning.endMin),
      }),
      detail: t('Prioritaire sur les autres commerces en matinée.'),
    },
    {
      icon: <IconUtensils size={14} />,
      title: t('Repas {{lunchFrom}}–{{lunchTo}} et {{dinnerFrom}}–{{dinnerTo}}', {
        lunchFrom: formatClock(tod.lunch.startMin),
        lunchTo: formatClock(tod.lunch.endMin),
        dinnerFrom: formatClock(tod.mealGuarantees[1]?.startMin ?? tod.evening.startMin),
        dinnerTo: formatClock(tod.mealGuarantees[1]?.endMin ?? tod.evening.endMin),
      }),
      detail: t('Au moins un arrêt ravitaillement par créneau repas.'),
    },
    {
      icon: <IconFuel size={14} />,
      title: t('Nuit ({{from}}–{{to}})', {
        from: formatClock(tod.deepNight.startMin),
        to: formatClock(tod.deepNight.endMin),
      }),
      detail: t('Stations-service et commerces ouverts 24h/24 en priorité.'),
    },
    {
      icon: <IconBed size={14} />,
      title: t('Hôtels de {{from}} à {{to}}', {
        from: formatClock(rules.hotel.window.startMin),
        to: formatClock(rules.hotel.window.endMin),
      }),
      detail: t("Jusqu'à {{evening}} options en soirée ({{from}}–{{to}}), puis {{late}} par tranche jusqu'au matin.", {
        evening: rules.hotel.slots[0]?.max ?? 0,
        from: formatClock(rules.hotel.slots[0]?.startMin ?? rules.hotel.window.startMin),
        to: formatClock(rules.hotel.slots[0]?.endMin ?? rules.hotel.window.endMin),
        late: rules.hotel.slots[1]?.max ?? 0,
      }),
    },
    {
      icon: <IconRoute size={14} />,
      title: t('Avant un désert de {{hours}}h', { hours: rules.gap.desertH }),
      detail: t(
        "Si le prochain POI du même type est à plus de {{hours}}h, le dernier avant le trou est ajouté d'office.",
        { hours: rules.gap.desertH },
      ),
    },
  ];

  const stats = summary
    ? [
      { value: summary.byReason.water, label: t('Eau') },
      {
        value: summary.byReason.resupply + summary.byReason.bakery + summary.byReason.meal + summary.byReason.night,
        label: t('Ravito'),
      },
      { value: summary.byReason.hotel, label: t('Hôtels') },
      { value: summary.byReason.gap6h, label: t('Avant désert') },
    ]
    : [];

  return createPortal(
    <div className="rvi-autosort-dialog" role="presentation" onMouseDown={onClose}>
      <div
        className="rvi-autosort-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rvi-autosort-dialog-title"
        style={{ transform: `scale(${scale})` }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="rvi-autosort-dialog__header">
          <span className="rvi-autosort-dialog__badge" aria-hidden>
            <IconSparkles size={16} />
          </span>
          <div className="rvi-autosort-dialog__heading">
            <h2 id="rvi-autosort-dialog-title" className="rvi-autosort-dialog__title">
              {t('Tri automatique des POI')}
            </h2>
            <p className="rvi-autosort-dialog__subtitle">
              {t("La feuille de route ne garde que les POI utiles à vos heures de passage prévues, plus vos favoris. Rien n'est ajouté à la timeline.")}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="rvi-autosort-dialog__close"
            aria-label={t('Fermer')}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="rvi-autosort-dialog__body">
          {summary ? (
            <section className="rvi-autosort-dialog__section">
              <div className="rvi-autosort-dialog__section-title">
                {t('Dernier tri')}
                <span className="rvi-autosort-dialog__total">
                  {t('{{count}} POI retenus', { count: summary.total })}
                </span>
              </div>
              <div className="rvi-autosort-dialog__stats">
                {stats.map((stat) => (
                  <div key={stat.label} className="rvi-autosort-dialog__stat">
                    <span className="rvi-autosort-dialog__stat-value">{stat.value}</span>
                    <span className="rvi-autosort-dialog__stat-label">{stat.label}</span>
                  </div>
                ))}
              </div>
              {stale ? (
                <div className="rvi-autosort-dialog__note rvi-autosort-dialog__note--warn">
                  {t('Les POI, le départ ou le rythme ont changé : le tri sera mis à jour.')}
                </div>
              ) : null}
              {!summary.usedPrediction ? (
                <div className="rvi-autosort-dialog__note">
                  {t('Heures estimées à 18 km/h : calculez le rythme pour un tri plus juste.')}
                </div>
              ) : null}
              {summary.warnings.length > 0 ? (
                <ul className="rvi-autosort-dialog__gaps">
                  {summary.warnings.map((warning) => (
                    <li key={`${warning.kind}-${warning.fromKm}-${warning.toKm}`} className="rvi-autosort-dialog__gap">
                      <span className="rvi-autosort-dialog__gap-kind">
                        {warning.kind === 'waterGap' ? t("Pas d'eau") : t('Pas de ravito')}
                      </span>
                      <span>
                        {t('km {{from}} → {{to}}', {
                          from: Math.round(warning.fromKm),
                          to: Math.round(warning.toKm),
                        })}
                      </span>
                      <span className="rvi-autosort-dialog__gap-hours">{formatHours(warning.hours)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section className="rvi-autosort-dialog__section">
            <div className="rvi-autosort-dialog__section-title">{t('Critères')}</div>
            <ul className="rvi-autosort-dialog__criteria">
              {criteria.map((criterion) => (
                <li key={criterion.title} className="rvi-autosort-dialog__criterion">
                  <span className="rvi-autosort-dialog__criterion-icon" aria-hidden>
                    {criterion.icon}
                  </span>
                  <span className="rvi-autosort-dialog__criterion-text">
                    <span className="rvi-autosort-dialog__criterion-title">{criterion.title}</span>
                    <span className="rvi-autosort-dialog__criterion-detail">{criterion.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="rvi-autosort-dialog__footer">
          <button type="button" className="rvi-autosort-dialog__btn" onClick={onClose}>
            {t('Fermer')}
          </button>
          {onEnable ? (
            <button
              type="button"
              className="rvi-autosort-dialog__btn rvi-autosort-dialog__btn--primary"
              onClick={onEnable}
            >
              <IconSparkles size={16} />
              {t('Activer le tri')}
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
