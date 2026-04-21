import {
  IconDotsVertical,
  IconEye,
  IconSettingsSliders,
} from './CenterPanelIcons';

const headerCells = [
  'Distance',
  'Durée',
  'Dénivelé /',
  'Dénivelé -',
  'Pente moyenne',
  'Tarmac',
  'Off-road',
  '7%',
  '7%',
  '7%',
];

const values = ['12.78', '00:00:23', '+346', '-33', '7%', '7%', '7%', '7%', '7%', '7%'];

export function CenterPanelSummary() {
  return (
    <section className="rvc-center-summary" aria-label="Synthèse d'itinéraire">
      <div className="rvc-center-summary__row rvc-center-summary__row--header">
        <div className="rvc-center-summary__title">Synthèse</div>
        <div className="rvc-center-summary__metrics" aria-hidden="true">
          {headerCells.map((cell) => (
            <div key={cell} className="rvc-center-summary__metric rvc-center-summary__metric--header" title={cell}>
              {cell}
            </div>
          ))}
        </div>
        <button className="rvc-center-summary__icon-button" type="button" aria-label="Réglages">
          <IconSettingsSliders size={16} />
        </button>
      </div>

      <div className="rvc-center-summary__row rvc-center-summary__row--item">
        <div className="rvc-center-summary__route">
          <span className="rvc-center-summary__eye" aria-hidden="true">
            <IconEye size={14} />
          </span>
          <span className="rvc-center-summary__color" aria-hidden="true" />
          <span className="rvc-center-summary__name" title="Itinéraire 1">Itinéraire 1</span>
        </div>
        <div className="rvc-center-summary__metrics">
          {values.map((cell, index) => (
            <div key={`${cell}-${index}`} className="rvc-center-summary__metric" title={cell}>
              {cell}
            </div>
          ))}
        </div>
        <button className="rvc-center-summary__ghost-button" type="button" aria-label="Plus d'options">
          <IconDotsVertical size={16} />
        </button>
      </div>
    </section>
  );
}
