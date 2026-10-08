import { useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { RoadTypesState } from '../../types';
import { IconFigmaCheck, IconFigmaChevronDown } from '../../components/iconsFigma';
import { FOOT_SLOPE_OPTIONS, SLOPE_OPTIONS } from './activity';
import { ParamDropdownItem, SlopeParamItem } from './ParamItems';

interface AdditionalParamsProps {
  roadTypes: RoadTypesState;
  /** À pied : pentes plus raides proposées, trottoirs au lieu des voies cyclables. */
  isFoot: boolean;
  onChangeRoadType?: <K extends keyof RoadTypesState>(key: K, value: RoadTypesState[K]) => void;
}

/** Accordéon « Paramètres additionnels » (dénivelé, pentes, axes, bois, ferry…). */
export function AdditionalParams({ roadTypes, isFoot, onChangeRoadType }: AdditionalParamsProps) {
  const { t } = useAppI18n();
  const [paramsOpen, setParamsOpen] = useState(false);

  return (
    <div className="rvi-tracage__params">
      <button
        type="button"
        className="rvi-tracage__params-trigger"
        onClick={() => setParamsOpen((prev) => !prev)}
        aria-expanded={paramsOpen}
      >
        <span className="rvi-tracage__params-title">{t('Paramètres additionnels')}</span>
        <span className={`rvi-tracage__params-chevron${paramsOpen ? ' is-open' : ''}`}>
          <IconFigmaChevronDown size={15} />
        </span>
      </button>

      {/* Accordéon en grille CSS fluide */}
      <div className={`rvi-tracage__params-accordion${paramsOpen ? ' is-open' : ''}`}>
        <div className="rvi-tracage__params-accordion-inner">
          <div className="rvi-tracage__params-grid">
            {/* Row 1: Dénivelé & Pente max */}
            <div className="rvi-tracage__params-row">
              <ParamDropdownItem
                label={t('Dénivelé')}
                value={roadTypes.elevationPreference ?? 'avoid'}
                onChange={(val) => onChangeRoadType?.('elevationPreference', val)}
              />
              <SlopeParamItem
                label={t('Pente max')}
                value={roadTypes.maxSlopePercent ?? 12}
                options={isFoot ? FOOT_SLOPE_OPTIONS : SLOPE_OPTIONS}
                onChange={(val) => onChangeRoadType?.('maxSlopePercent', val)}
              />
            </div>

            {/* Row 2: Axes majeurs & Voies cyclables (trottoirs à pied) */}
            <div className="rvi-tracage__params-row">
              <ParamDropdownItem
                label={t('Axes majeurs')}
                value={roadTypes.majorRoads ?? 'prefer'}
                onChange={(val) => onChangeRoadType?.('majorRoads', val)}
              />
              <ParamDropdownItem
                label={isFoot ? t('Trottoirs & voies piétonnes') : t('Voies cyclables')}
                value={roadTypes.bikeLanes ?? 'tolerate'}
                onChange={(val) => onChangeRoadType?.('bikeLanes', val)}
              />
            </div>

            {/* Row 3: Bois (protection vent et soleil) & Intersections */}
            <div className="rvi-tracage__params-row">
              <ParamDropdownItem
                label={t('Bois (protection vent et soleil)')}
                value={roadTypes.woods ?? 'prefer'}
                onChange={(val) => onChangeRoadType?.('woods', val)}
              />
              <ParamDropdownItem
                label={t('Intersections')}
                value={roadTypes.turns ?? 'tolerate'}
                onChange={(val) => onChangeRoadType?.('turns', val)}
              />
            </div>

            {/* Ligne 4 : Ferry et Villes */}
            <div className="rvi-tracage__params-row">
              <ParamDropdownItem
                label={t('Ferry')}
                value={roadTypes.ferry ?? 'forbid'}
                onChange={(val) => onChangeRoadType?.('ferry', val)}
              />
              <ParamDropdownItem
                label={t('Villes')}
                value={roadTypes.cities ?? 'avoid'}
                onChange={(val) => onChangeRoadType?.('cities', val)}
              />
            </div>
          </div>

          {/* Checkbox: Appliquer à tout les itinéraires (Figma 5925:123599) */}
          <button
            type="button"
            className="rvi-tracage__checkbox-row"
            onClick={() =>
              onChangeRoadType?.('applyToAllItineraries', !roadTypes.applyToAllItineraries)
            }
            role="checkbox"
            aria-checked={Boolean(roadTypes.applyToAllItineraries)}
          >
            <span
              className={`rvi-tracage__checkbox${roadTypes.applyToAllItineraries ? ' is-checked' : ''}`}
            >
              {roadTypes.applyToAllItineraries && <IconFigmaCheck size={10} />}
            </span>
            <span className="rvi-tracage__checkbox-text">
              {t('Appliquer à tout les itinéraires')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
