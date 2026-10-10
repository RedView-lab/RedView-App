import { Fragment, useMemo, useState, type CSSProperties, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import {
  flyoverVideoFileName,
  isFlyoverVideoExportRunning,
  startFlyoverVideoExport,
  useFlyoverController,
  type FlyoverVideoOrientation,
} from '@/features/centerPanel/flyover';
import {
  countExportPois,
  exportItineraryFile,
  GARMIN_COURSE_POINT_LIMIT,
  gpsNameExamples,
  resolveExportRouteName,
  type ExportPoiScope,
  type ItineraryExportFormat,
} from '@/features/exporter';
import { usePredictionStoreOptional, useProjectStoreOptional } from '@/features/itineraryPanel';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { describeRedviewExportError, exportProjectAsRedview } from '@/features/redviewFile';
import { useAppI18n } from '@/shared/i18n';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { preloadTimeZoneTable } from '@/shared/lib/timeZoneAt';
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

// Formats d'export d'itinéraire proposés dans la liste. KML figure à côté de
// GPX / FIT pour que l'utilisateur puisse envoyer les POI favoris + la trace
// vers une montre / un compteur (Garmin, Coros) ou un visualiseur (Google Earth).
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

/**
 * Format d'itinéraire retenu sur cet appareil : qui exporte en FIT pour son
 * Garmin n'a pas à le rechoisir à chaque fois. Préférence locale, au mieux.
 */
const ITINERARY_FORMAT_STORAGE_KEY = 'redview:exporter:itinerary-format';

function readStoredItineraryFormat(): ItineraryExportFormat | null {
  try {
    const stored = window.localStorage.getItem(ITINERARY_FORMAT_STORAGE_KEY);
    return ITINERARY_FORMAT_OPTIONS.some((option) => option.value === stored) ? (stored as ItineraryExportFormat) : null;
  } catch {
    return null;
  }
}

function storeItineraryFormat(format: ItineraryExportFormat): void {
  try {
    window.localStorage.setItem(ITINERARY_FORMAT_STORAGE_KEY, format);
  } catch {
    // Préférence de confort : sans stockage, GPX reste proposé par défaut.
  }
}

function initialRows(): ExportRow[] {
  const format = readStoredItineraryFormat();
  return format
    ? INITIAL_ROWS.map((row) => (row.id === 'itineraries' ? { ...row, format } : row))
    : INITIAL_ROWS;
}

export const ExporterPanel = memo(function ExporterPanel({
  width,
  projectId = null,
  map = null,
  getProjectSnapshot,
}: ExporterPanelProps) {
  const { t, locale } = useAppI18n();
  const store = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const flyover = useFlyoverController();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(initialRows);
  const [isExporting, setIsExporting] = useState(false);
  const [status, setStatus] = useState<{ tone: 'idle' | 'success' | 'error'; message: string } | null>(null);
  const style: CSSProperties | undefined = width ? { width } : undefined;

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  ) ?? null;

  // POI exportés avec la trace (GPX / FIT / KML) : par défaut ceux de la
  // feuille de route, ou les favoris quand la feuille de route dépasse ce
  // qu'un compteur Garmin annonce.
  const [poiScopeChoice, setPoiScopeChoice] = useState<ExportPoiScope | null>(null);
  const poiCounts = useMemo(() => (activeItinerary ? countExportPois(activeItinerary) : null), [activeItinerary]);
  const waypointCount = useMemo(
    () => activeItinerary?.timeline.filter((row) => row.kind === 'waypoint' && Number.isFinite(row.lat) && Number.isFinite(row.lon)).length ?? 0,
    [activeItinerary],
  );
  const defaultPoiScope: ExportPoiScope = poiCounts
    && poiCounts.roadbook + waypointCount > GARMIN_COURSE_POINT_LIMIT
    && poiCounts.favorites > 0
    ? 'favorites'
    : 'roadbook';
  const poiScope = poiScopeChoice ?? defaultPoiScope;
  const poiScopeOptions: { value: ExportPoiScope; label: string }[] = [
    { value: 'roadbook', label: t('Feuille de route ({{count}})', { count: poiCounts?.roadbook ?? 0 }) },
    { value: 'favorites', label: t('Favoris ({{count}})', { count: poiCounts?.favorites ?? 0 }) },
    { value: 'all', label: t('Tous les POI ({{count}})', { count: poiCounts?.all ?? 0 }) },
    { value: 'none', label: t('Aucun POI') },
  ];
  const coursePointCount = (poiScope === 'none' ? 0 : poiCounts?.[poiScope] ?? 0) + waypointCount;

  const handleToggle = (id: string, nextChecked: boolean) => {
    setRows((current) =>
      current.map((row) =>
        row.id === id && !row.disabled ? { ...row, checked: nextChecked } : row,
      ),
    );
  };

  const handleFormatChange = (id: string, nextFormat: ExportFormat) => {
    if (id === 'itineraries' && ITINERARY_FORMAT_OPTIONS.some((option) => option.value === nextFormat)) {
      storeItineraryFormat(nextFormat as ItineraryExportFormat);
    }
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
    const { fileName } = exportItineraryFile(activeItinerary, format, {
      pois: poiScope,
      // Heures de passage (horodatage FIT, horaires du jour) : la prédiction affichée.
      prediction: predictionStore?.predictions[activeItinerary.id] ?? activeItinerary.prediction ?? null,
    });
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
    const parts = [t('Projet exporté : {{file}}', { file: result.fileName })];
    if (result.missingFitFiles.length > 0) {
      parts.push(t('{{count}} fichier(s) .fit supprimé(s) du stockage non inclus.', { count: result.missingFitFiles.length }));
    }
    if (result.withheldFitFileCount > 0) {
      parts.push(t('{{count}} fichier(s) .fit d’autres membres non inclus.', { count: result.withheldFitFileCount }));
    }
    return parts.join(' ');
  };

  /** Lance le rendu (long) en arrière-plan ; son avancement s'affiche sous le bouton. */
  const startVideoExport = (format: ExportFormat): void => {
    if (isFlyoverVideoExportRunning()) throw new Error('Une vidéo est déjà en cours de rendu.');
    const source = flyover?.getVideoSource() ?? null;
    if (!map || !source) throw new Error('Aucun tracé à survoler pour la vidéo.');
    const orientation: FlyoverVideoOrientation = format === 'mp4-portrait' ? 'portrait' : 'landscape';
    const itinerary = store?.project.itineraries.find((candidate) => candidate.id === source.route.itineraryId);
    const name = (itinerary ? resolveExportRouteName(itinerary) : '') || 'flyover';
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
          // Fuseaux des lieux (horodatage FIT, horaires d'un POI passé une
          // frontière) : la table doit être chargée, sinon le navigateur tient
          // lieu de fuseau sans le dire. Déjà là en général (panneau d'itinéraire).
          await preloadTimeZoneTable().catch(() => undefined);
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
                <Fragment key={row.id}>
                  <div className={`rvc-exporter-panel__row${row.disabled ? ' is-disabled' : ''}`}>
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
                  {row.id === 'itineraries' && row.checked && activeItinerary ? (
                    <div className="rvc-exporter-panel__pois">
                      <div className="rvc-exporter-panel__row rvc-exporter-panel__row--sub">
                        <span className="rvc-exporter-panel__sublabel">{t('POI')}</span>
                        <Select
                          className="rvc-exporter-panel__select rvc-exporter-panel__select--wide"
                          value={poiScope}
                          options={poiScopeOptions}
                          onChange={setPoiScopeChoice}
                        />
                      </div>
                      {row.format !== 'kml' && poiScope !== 'none' ? (
                        <p className="rvc-exporter-panel__hint">
                          {t('Noms GPS : {{examples}}', { examples: gpsNameExamples(locale).join(' · ') })}
                        </p>
                      ) : null}
                      {row.format !== 'kml' && coursePointCount > GARMIN_COURSE_POINT_LIMIT ? (
                        <p className="rvc-exporter-panel__hint rvc-exporter-panel__hint--warning">
                          {t('{{count}} points de parcours : au-delà de {{limit}}, certains compteurs Garmin n’annoncent plus les derniers.', {
                            count: coursePointCount,
                            limit: GARMIN_COURSE_POINT_LIMIT,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </Fragment>
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
                  // Tons d'état du thème clair (le vert / rouge pâle du sombre y était illisible).
                  color: status.tone === 'error' ? 'light-dark(#b42318, #ff8d8d)' : 'light-dark(#067647, #cbe8b1)',
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