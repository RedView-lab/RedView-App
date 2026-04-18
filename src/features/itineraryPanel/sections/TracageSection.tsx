import { LabeledSlider } from '../components/LabeledSlider';
import { LabeledSelect, LabeledInput } from '../components/LabeledSelect';
import { CheckboxField } from '../components/PanelCheckbox';
import type { PrioritiesState, RoadTypesState } from '../types';

interface TracageSectionProps {
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  onChangePriority?: (key: keyof PrioritiesState, value: number) => void;
  onChangeRoadType?: <K extends keyof RoadTypesState>(
    key: K,
    value: RoadTypesState[K],
  ) => void;
}

/**
 * Traçage section — Figma 1701:23356 (PARAMETRES / SETTINGS block).
 *
 * Layout is a stack of three blocks separated by 1 px dividers:
 *   1. Priorités   → 2 vertical columns of 2 sliders (Figma 1697:23227).
 *   2. Types de route → 5 rows × 2 cells of labeled selects / input
 *      (Figma 1697:23276…1697:23321).
 *   3. Apply-to-all checkbox (Figma 1705:23497).
 */
export function TracageSection({
  priorities,
  roadTypes,
  onChangePriority,
  onChangeRoadType,
}: TracageSectionProps) {
  return (
    <div className="rvi-params">
      <div className="rvi-divider" />

      <h3 className="rvi-section-title">Priorités</h3>
      <div className="rvi-priorities">
        <div className="rvi-priorities__col">
          <LabeledSlider
            label="Durée"
            value={priorities.duration}
            onChange={(v) => onChangePriority?.('duration', v)}
          />
          <LabeledSlider
            label="Distance"
            value={priorities.distance}
            onChange={(v) => onChangePriority?.('distance', v)}
          />
        </div>
        <div className="rvi-priorities__col">
          <LabeledSlider
            label="Dénivelé"
            value={priorities.elevation}
            onChange={(v) => onChangePriority?.('elevation', v)}
          />
          <LabeledSlider
            label="Tranquilité"
            value={priorities.tranquility}
            onChange={(v) => onChangePriority?.('tranquility', v)}
          />
        </div>
      </div>

      <div className="rvi-divider" />

      <h3 className="rvi-section-title">Types de route</h3>

      <div className="rvi-row">
        <LabeledSelect
          label="Route"
          value={roadTypes.road}
          onChange={(v) => onChangeRoadType?.('road', v)}
        />
        <LabeledSelect
          label="Gravel"
          value={roadTypes.gravel}
          onChange={(v) => onChangeRoadType?.('gravel', v)}
        />
      </div>
      <div className="rvi-row">
        <LabeledSelect
          label="Singletrack"
          value={roadTypes.singletrack}
          onChange={(v) => onChangeRoadType?.('singletrack', v)}
        />
        <LabeledSelect
          label="Hors-piste"
          value={roadTypes.offroad}
          onChange={(v) => onChangeRoadType?.('offroad', v)}
        />
      </div>
      <div className="rvi-row">
        <LabeledSelect
          label="Voix cyclables"
          value={roadTypes.bikeLanes}
          onChange={(v) => onChangeRoadType?.('bikeLanes', v)}
        />
        <LabeledSelect
          label="Axes majeurs"
          value={roadTypes.majorRoads}
          onChange={(v) => onChangeRoadType?.('majorRoads', v)}
        />
      </div>
      <div className="rvi-row">
        <LabeledSelect
          label="Ferry"
          value={roadTypes.ferry}
          onChange={(v) => onChangeRoadType?.('ferry', v)}
        />
        <LabeledSelect
          label="Virages"
          value={roadTypes.turns}
          onChange={(v) => onChangeRoadType?.('turns', v)}
        />
      </div>
      <div className="rvi-row">
        <LabeledInput
          label="Pentes max."
          value={`${roadTypes.maxSlopePercent}%`}
          onChange={(v) => {
            const n = parseInt(v.replace('%', ''), 10);
            if (Number.isFinite(n)) onChangeRoadType?.('maxSlopePercent', n);
          }}
          placeholder="20%"
        />
        <LabeledSelect
          label="Villes"
          value={roadTypes.cities}
          onChange={(v) => onChangeRoadType?.('cities', v)}
        />
      </div>

      <CheckboxField
        checked={roadTypes.applyToAllItineraries}
        onToggle={(v) => onChangeRoadType?.('applyToAllItineraries', v)}
        label="Appliquer à tout les itinéraires"
        trailing={null}
      />
    </div>
  );
}
