import { useState, type CSSProperties, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  flyoverVideoFileName,
  isFlyoverVideoExportRunning,
  startFlyoverVideoExport,
  useFlyoverController,
  type FlyoverVideoOrientation,
} from '@/features/centerPanel/flyover';
import { exportItineraryFile, type ItineraryExportFormat } from '@/features/exporter';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { describeRedviewExportError, exportProjectAsRedview } from '@/features/redviewFile';
import { useAppI18n } from '@/shared/i18n';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { captureMapThumbnail } from '@/shared/lib/mapThumbnail';

import { Checkbox } from './Checkbox';
import { Select } from './Select';
import { VideoExportStatus } from './VideoExportStatus';
import { IconChevronDown, IconDownload01, IconShare01 } from '../icons';
import '../styles/index.css';

type VideoExportFormat = 'mp4-landscape' | 'mp4-portrait';
type ExportFormat = ItineraryExportFormat | 'redview' | VideoExportFormat;

// Vidéo du flyover 3D : horizontale (1920 × 1080) ou verticale (1080 × 1920).
const VIDEO_FORMAT_OPTIONS: { value: VideoExportFormat; label: string }[] = [
  { value: 'mp4-landscape', label: 'MP4 16:9' },
  { value: 'mp4-portrait', label: 'MP4 9:16' },
];

// Itinerary export formats selectable in the dropdown. KML is listed
// alongside GPX/FIT so the user can send favorited POIs + the trace to a
// watch/bike computer (Garmin, Coros) or a visualizer (Google Earth).
const ITINERARY_FORMAT_OPTIONS: { value: ItineraryExportFormat; label: string }[] = [
  { value: 'gpx', label: 'GPX' },
  { value: 'kml', label: 'KML' },
  { value: 'fit', label: 'FIT' },
];

interface ExporterPanelProps {
  width?: number | '100%';
  /** Projet ouvert (miniature enregistrée en repli de la capture de la carte). */
  projectId?: string | null;
  /** Carte : miniature du fichier .redview capturée au moment de l'export. */
  map?: MapboxMap | null;
  /**
   * État complet du projet ouvert, vue carte et panneaux compris (tenus par
   * le Dashboard hors du ProjectStore). Sans lui, le projet du store.
   */
  getProjectSnapshot?: () => ItineraryProject | null;
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
  redview: [{ value: 'redview', label: 'REDVIEW' }],
  'mp4-landscape': VIDEO_FORMAT_OPTIONS,
  'mp4-portrait': VIDEO_FORMAT_OPTIONS,
};

const INITIAL_ROWS: ExportRow[] = [
  // Fichier .redview : tout le projet (tracés, prédictions, POI, .fit…), à partager
  // et à rouvrir avec « Importer un projet » dans le gestionnaire de projets.
  { id: 'project', label: 'Projet complet', format: 'redview', checked: false },
  { id: 'itineraries', label: 'Itinéraire(s)', format: 'gpx', checked: true },
  // Flyover de l'itinéraire rendu image par image hors écran (style de la carte
  // du moment, palier de vitesse du flyover), encodé en MP4 H.264.
  { id: 'video', label: 'Vidéo flyover', format: 'mp4-landscape', checked: false },
];

export const ExporterPanel = memo(function ExporterPanel({
  width,
  projectId = null,
  map = null,
  getProjectSnapshot,
}: ExporterPanelProps) {
  const { t } = useAppI18n();
  const store = useProjectStoreOptional();
  const flyover = useFlyoverController();
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

  const exportActiveItinerary = (format: ExportFormat): string => {
    if (!activeItinerary) throw new Error('Aucun itinéraire actif à exporter.');
    if (format !== 'gpx' && format !== 'fit' && format !== 'kml') {
      throw new Error("Le format sélectionné n'est pas encore pris en charge pour l'itinéraire.");
    }
    const { fileName } = exportItineraryFile(activeItinerary, format);
    // Moment de valeur : le parcours part vers le GPS / l'appli de navigation.
    trackAnalyticsEvent({ name: 'route_exported', data: { format, scope: 'itinerary' } });
    return t("{{files}} exporté depuis l'itinéraire actif.", { files: fileName });
  };

  const exportFullProject = async (): Promise<string> => {
    const project = getProjectSnapshot?.() ?? store?.project ?? null;
    if (!project) throw new Error('No open project');
    // Miniature de la vue actuelle ; à défaut, celle enregistrée du projet.
    const thumbnail = await captureMapThumbnail(map).catch(() => null);
    const result = await exportProjectAsRedview({ project, projectId, thumbnail });
    trackAnalyticsEvent({ name: 'project_file_exported', data: { from: 'editor' } });
    const exported = t('Projet exporté : {{file}}', { file: result.fileName });
    return result.missingFitFiles.length > 0
      ? `${exported} ${t('{{count}} fichier(s) .fit supprimé(s) du stockage non inclus.', { count: result.missingFitFiles.length })}`
      : exported;
  };

  /** Lance le rendu (long) en arrière-plan ; son avancement s'affiche sous le bouton. */
  const startVideoExport = (format: ExportFormat): void => {
    if (isFlyoverVideoExportRunning()) throw new Error('Une vidéo est déjà en cours de rendu.');
    const source = flyover?.getVideoSource() ?? null;
    if (!map || !source) throw new Error('Aucun tracé à survoler pour la vidéo.');
    const orientation: FlyoverVideoOrientation = format === 'mp4-portrait' ? 'portrait' : 'landscape';
    const itinerary = store?.project.itineraries.find((candidate) => candidate.id === source.route.itineraryId);
    const name = itinerary?.gpxRoute?.name?.trim() || itinerary?.name?.trim() || 'flyover';
    void startFlyoverVideoExport({
      liveMap: map,
      route: source.route,
      speedIndex: source.speedIndex,
      orientation,
      fileName: flyoverVideoFileName(name, orientation),
    });
  };

  // Chaque export coché part indépendamment : un itinéraire sans tracé ne
  // bloque pas l'export du projet complet, et inversement.
  const handleExport = async () => {
    const selected = rows.filter((row) => row.checked && !row.disabled);
    if (selected.length === 0) {
      setStatus({ tone: 'error', message: t('Activez au moins un export avant de lancer le téléchargement.') });
      return;
    }

    setIsExporting(true);
    setStatus(null);
    const outcomes: Array<{ ok: boolean; message: string }> = [];
    try {
      const itineraryRow = selected.find((row) => row.id === 'itineraries');
      if (itineraryRow) {
        try {
          outcomes.push({ ok: true, message: exportActiveItinerary(itineraryRow.format) });
        } catch (error) {
          console.error('[exporter] failed to export itinerary', error);
          outcomes.push({
            ok: false,
            message: error instanceof Error ? t(error.message) : t("Impossible d'exporter l'itinéraire actif."),
          });
        }
      }
      if (selected.some((row) => row.id === 'project')) {
        try {
          outcomes.push({ ok: true, message: await exportFullProject() });
        } catch (error) {
          console.error('[exporter] failed to export project', error);
          outcomes.push({ ok: false, message: t(describeRedviewExportError(error)) });
        }
      }
      const videoRow = selected.find((row) => row.id === 'video');
      if (videoRow) {
        try {
          startVideoExport(videoRow.format);
        } catch (error) {
          outcomes.push({
            ok: false,
            message: error instanceof Error ? t(error.message) : t('Rendu de la vidéo impossible.'),
          });
        }
      }
      setStatus(
        outcomes.length === 0
          ? null
          : {
              tone: outcomes.every((outcome) => outcome.ok) ? 'success' : 'error',
              message: outcomes.map((outcome) => outcome.message).join(' '),
            },
      );
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
                    width="var(--rvc-exporter-select-width)"
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

            <VideoExportStatus />

            {status ? (
              <p
                role={status.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                style={{
                  margin: '8px 0 0',
                  fontSize: 'var(--rv-font-size-sm)',
                  fontWeight: 500,
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