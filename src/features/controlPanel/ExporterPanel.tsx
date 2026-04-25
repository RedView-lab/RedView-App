import { useState, type CSSProperties } from 'react';

import { Checkbox } from './components/Checkbox';
import { Select } from './components/Select';
import { IconChevronDown, IconDownload01, IconShare01 } from './icons';
import './styles/index.css';

type ExportFormat = 'gpx' | 'excel' | 'pdf';

interface ExporterPanelProps {
  width?: number;
}

interface ExportRow {
  id: string;
  label: string;
  format: ExportFormat;
  checked: boolean;
  disabled?: boolean;
}

const FORMAT_OPTIONS: Record<ExportFormat, { value: ExportFormat; label: string }[]> = {
  gpx: [{ value: 'gpx', label: 'GPX' }],
  excel: [{ value: 'excel', label: 'Excel' }],
  pdf: [{ value: 'pdf', label: 'PDF' }],
};

const INITIAL_ROWS: ExportRow[] = [
  { id: 'itineraries', label: 'Itinéraire(s)', format: 'gpx', checked: true },
  { id: 'sheet', label: 'Feuille de route', format: 'excel', checked: true },
  { id: 'timeline', label: 'Timeline', format: 'pdf', checked: false, disabled: true },
  { id: 'summary', label: 'Synthèse', format: 'excel', checked: false, disabled: true },
  { id: 'chart', label: 'Graphique', format: 'pdf', checked: false, disabled: true },
];

export function ExporterPanel({ width }: ExporterPanelProps) {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(INITIAL_ROWS);
  const style: CSSProperties | undefined = width ? { width } : undefined;

  const handleToggle = (id: string, nextChecked: boolean) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id && !row.disabled ? { ...row, checked: nextChecked } : row,
      ),
    );
  };

  return (
    <aside
      className={`rvc-panel rvc-exporter-panel${open ? ' is-open' : ' is-collapsed'}`}
      style={style}
      aria-label="Panneau d'export"
    >
      <div className="rvc-exporter-panel__content">
        <header className="rvc-exporter-panel__header">
          <span className="rvc-exporter-panel__icon" aria-hidden="true">
            <IconShare01 size={12} />
          </span>
          <button
            type="button"
            className="rvc-exporter-panel__title-btn"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
          >
            <span className="rvc-exporter-panel__title">Exporter</span>
          </button>
          <button
            type="button"
            className={`rvc-exporter-panel__chevron${open ? ' is-open' : ''}`}
            onClick={() => setOpen((current) => !current)}
            aria-label={open ? 'Réduire le module exporter' : 'Développer le module exporter'}
            aria-expanded={open}
          >
            <IconChevronDown size={16} />
          </button>
        </header>

        <div
          className={`rvc-exporter-panel__body${open ? ' is-open' : ''}`}
          aria-hidden={!open}
        >
          <div className="rvc-exporter-panel__body-inner">
            <div className="rvc-exporter-panel__divider" aria-hidden="true" />

            <div className="rvc-exporter-panel__rows">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className={`rvc-exporter-panel__row${row.disabled ? ' is-disabled' : ''}`}
                >
                  <Checkbox
                    id={`export-${row.id}`}
                    checked={row.checked}
                    onChange={(nextChecked) => handleToggle(row.id, nextChecked)}
                    label={row.label}
                  />
                  <Select
                    className="rvc-exporter-panel__select"
                    value={row.format}
                    options={FORMAT_OPTIONS[row.format]}
                    width="var(--rvc-panel-select-xs)"
                  />
                </div>
              ))}
            </div>

            <button type="button" className="rvc-btn-primary rvc-exporter-panel__submit">
              <IconDownload01 size={18} />
              <span>Exporter</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}