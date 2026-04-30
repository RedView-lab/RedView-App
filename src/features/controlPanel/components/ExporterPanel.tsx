import { useState, type CSSProperties } from 'react';

import { exportItineraryFile, exportRoadbookExcel, type ItineraryExportFormat } from '@/features/exporter';
import { useProjectStoreOptional } from '@/features/itineraryPanel';

import { Checkbox } from './Checkbox';
import { Select } from './Select';
import { IconChevronDown, IconDownload01, IconShare01 } from '../icons';
import '../styles/index.css';

type ExportFormat = ItineraryExportFormat | 'excel' | 'pdf';

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
  gpx: [
    { value: 'gpx', label: 'GPX' },
    { value: 'fit', label: 'FIT' },
  ],
  fit: [
    { value: 'gpx', label: 'GPX' },
    { value: 'fit', label: 'FIT' },
  ],
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
  const store = useProjectStoreOptional();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(INITIAL_ROWS);
  const [isExporting, setIsExporting] = useState(false);
  const [status, setStatus] = useState<{ tone: 'idle' | 'success' | 'error'; message: string } | null>(null);
  const style: CSSProperties | undefined = width ? { width } : undefined;

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  ) ?? null;

  const handleToggle = (id: string, nextChecked: boolean) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id && !row.disabled ? { ...row, checked: nextChecked } : row,
      ),
    );
  };

  const handleFormatChange = (id: string, nextFormat: ExportFormat) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id && !row.disabled ? { ...row, format: nextFormat } : row,
      ),
    );
  };

  const handleExport = async () => {
    const itineraryRow = rows.find((row) => row.id === 'itineraries' && row.checked && !row.disabled);
    const roadbookRow = rows.find((row) => row.id === 'sheet' && row.checked && !row.disabled);
    if (!itineraryRow && !roadbookRow) {
      setStatus({ tone: 'error', message: 'Activez au moins un export avant de lancer le telechargement.' });
      return;
    }
    if (!activeItinerary) {
      setStatus({ tone: 'error', message: 'Aucun itineraire actif a exporter.' });
      return;
    }
    if (itineraryRow && itineraryRow.format !== 'gpx' && itineraryRow.format !== 'fit') {
      setStatus({ tone: 'error', message: 'Le format selectionne n\'est pas encore pris en charge pour l\'itineraire.' });
      return;
    }
    if (roadbookRow && roadbookRow.format !== 'excel') {
      setStatus({ tone: 'error', message: 'La feuille de route est uniquement disponible en export Excel.' });
      return;
    }

    try {
      setIsExporting(true);
      setStatus(null);
      const exportedFiles: string[] = [];

      if (itineraryRow && (itineraryRow.format === 'gpx' || itineraryRow.format === 'fit')) {
        const { fileName } = exportItineraryFile(activeItinerary, itineraryRow.format);
        exportedFiles.push(fileName);
      }
      if (roadbookRow) {
        const { fileName } = await exportRoadbookExcel(activeItinerary);
        exportedFiles.push(fileName);
      }

      setStatus({
        tone: 'success',
        message: `${exportedFiles.join(' + ')} exporte depuis l\'itineraire actif.`,
      });
    } catch (error) {
      console.error('[exporter] failed to export itinerary', error);
      setStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Impossible d\'exporter l\'itineraire actif.',
      });
    } finally {
      setIsExporting(false);
    }
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
                    onChange={(nextFormat) => handleFormatChange(row.id, nextFormat)}
                    width="var(--rvc-panel-select-xs)"
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              className="rvc-btn-primary rvc-exporter-panel__submit"
              onClick={handleExport}
              disabled={isExporting}
            >
              <IconDownload01 size={18} />
              <span>{isExporting ? 'Export...' : 'Exporter'}</span>
            </button>

            {status ? (
              <p
                role={status.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                style={{
                  margin: '8px 0 0',
                  fontSize: 12,
                  lineHeight: 1.4,
                  color: status.tone === 'error' ? '#ff8d8d' : '#cbe8b1',
                }}
              >
                {status.message}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}