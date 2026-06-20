import { useState, type CSSProperties, memo } from 'react';

import { exportItineraryFile, exportRoadbookExcel, type ItineraryExportFormat } from '@/features/exporter';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { useAppI18n } from '@/shared/i18n';

import { Checkbox } from './Checkbox';
import { Select } from './Select';
import { IconChevronDown, IconDownload01, IconShare01 } from '../icons';
import '../styles/index.css';

type ExportFormat = ItineraryExportFormat | 'excel' | 'pdf';

// Itinerary export formats selectable in the dropdown. KML is listed
// alongside GPX/FIT so the user can send favorited POIs + the trace to a
// watch/bike computer (Garmin, Coros) or a visualizer (Google Earth).
const ITINERARY_FORMAT_OPTIONS: { value: ItineraryExportFormat; label: string }[] = [
  { value: 'gpx', label: 'GPX' },
  { value: 'kml', label: 'KML' },
  { value: 'fit', label: 'FIT' },
];

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
  gpx: ITINERARY_FORMAT_OPTIONS,
  kml: ITINERARY_FORMAT_OPTIONS,
  fit: ITINERARY_FORMAT_OPTIONS,
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

export const ExporterPanel = memo(function ExporterPanel({ width }: ExporterPanelProps) {
  const { t } = useAppI18n();
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
      setStatus({ tone: 'error', message: t('Activez au moins un export avant de lancer le téléchargement.') });
      return;
    }
    if (!activeItinerary) {
      setStatus({ tone: 'error', message: t('Aucun itinéraire actif à exporter.') });
      return;
    }
    if (
      itineraryRow
      && itineraryRow.format !== 'gpx'
      && itineraryRow.format !== 'fit'
      && itineraryRow.format !== 'kml'
    ) {
      setStatus({ tone: 'error', message: t("Le format sélectionné n'est pas encore pris en charge pour l'itinéraire.") });
      return;
    }
    if (roadbookRow && roadbookRow.format !== 'excel') {
      setStatus({ tone: 'error', message: t('La feuille de route est uniquement disponible en export Excel.') });
      return;
    }

    try {
      setIsExporting(true);
      setStatus(null);
      const exportedFiles: string[] = [];

      if (
        itineraryRow
        && (itineraryRow.format === 'gpx' || itineraryRow.format === 'fit' || itineraryRow.format === 'kml')
      ) {
        const { fileName } = exportItineraryFile(activeItinerary, itineraryRow.format);
        exportedFiles.push(fileName);
      }
      if (roadbookRow) {
        const { fileName } = await exportRoadbookExcel(activeItinerary);
        exportedFiles.push(fileName);
      }

      setStatus({
        tone: 'success',
        message: t(
          exportedFiles.length > 1
            ? "{{files}} exportés depuis l'itinéraire actif."
            : "{{files}} exporté depuis l'itinéraire actif.",
          { files: exportedFiles.join(' + ') },
        ),
      });
    } catch (error) {
      console.error('[exporter] failed to export itinerary', error);
      setStatus({
        tone: 'error',
        message: error instanceof Error ? t(error.message) : t("Impossible d'exporter l'itinéraire actif."),
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <aside
      className={`rvc-panel rvc-exporter-panel${open ? ' is-open' : ' is-collapsed'}`}
      style={style}
      aria-label={t("Panneau d'export")}
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
            <span className="rvc-exporter-panel__title">{t('Exporter')}</span>
          </button>
          <button
            type="button"
            className={`rvc-exporter-panel__chevron${open ? ' is-open' : ''}`}
            onClick={() => setOpen((current) => !current)}
            aria-label={open ? t('Réduire le module exporter') : t('Développer le module exporter')}
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
              <span>{isExporting ? t('Export...') : t('Exporter')}</span>
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
});