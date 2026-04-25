import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { SvgV2Icon } from '@/components/SvgV2Icon';
import { Slider } from '@/features/controlPanel/components/Slider';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { IconChevronDown } from './CenterPanelIcons';
import { useAnalysisFlyover } from '../flyover';

const DEFAULT_SIMPLIFY_TARGET_POINTS = 2_000;

type ToolbarIconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
};

const TOOLBAR_ICON_ASSETS = {
  cursor: 'navigation-pointer-01.svg',
  plusCircle: 'plus-circle.svg',
  pencil: 'edit-05.svg',
  switchHorizontal: 'switch-horizontal-01.svg',
  reflectVertical: 'reflect-01.svg',
  bezier: 'pen-tool-plus.svg',
  slashOctagon: 'slash-octagon.svg',
  wrench: 'tool-02.svg',
  trash: 'trash-03.svg',
  skip: 'skip-forward.svg',
  clockRewind: 'clock-rewind.svg',
} as const;

function assetIconStyle(direction?: 'forward' | 'backward'): CSSProperties | undefined {
  if (direction !== 'backward') return undefined;
  return { transform: 'scaleX(-1)' };
}

const IconUndo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-left.svg" size={size} {...rest} />
);

const IconRedo = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="corner-up-right.svg" size={size} {...rest} />
);

const IconCursor = ({ size = 18, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.cursor} size={size} {...rest} />
);

const IconPlusCircle = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.plusCircle} size={size} {...rest} />
);

const IconPencilLine = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.pencil} size={size} {...rest} />
);

const IconSwitchHorizontal = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.switchHorizontal} size={size} {...rest} />
);

const IconScissors = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="scissors.svg" size={size} {...rest} />
);

const IconReflectVertical = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.reflectVertical} size={size} {...rest} />
);

const IconBezier = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.bezier} size={size} {...rest} />
);

const IconSlashOctagon = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.slashOctagon} size={size} {...rest} />
);

const IconWrench = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.wrench} size={size} {...rest} />
);

const IconTrash = ({ size = 14, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.trash} size={size} {...rest} />
);

const IconSkip = ({ size = 16, direction = 'forward', ...rest }: ToolbarIconProps & { direction?: 'forward' | 'backward' }) => (
  <SvgV2Icon
    name={TOOLBAR_ICON_ASSETS.skip}
    size={size}
    style={assetIconStyle(direction)}
    {...rest}
  />
);

const IconPlay = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name="play.svg" size={size} {...rest} />
);

const IconPause = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <rect x="4.25" y="3" width="2.5" height="10" rx="0.9" fill="currentColor" />
    <rect x="9.25" y="3" width="2.5" height="10" rx="0.9" fill="currentColor" />
  </svg>
);

const IconClockRewind = ({ size = 16, ...rest }: ToolbarIconProps) => (
  <SvgV2Icon name={TOOLBAR_ICON_ASSETS.clockRewind} size={size} {...rest} />
);

function ToolbarIconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={active ? 'rvc-center-toolbar__button rvc-center-toolbar__button--active' : 'rvc-center-toolbar__button'}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeDefaultRetainPercent(pointCount: number): number {
  if (pointCount <= DEFAULT_SIMPLIFY_TARGET_POINTS) return 100;
  return clamp(
    Math.round((DEFAULT_SIMPLIFY_TARGET_POINTS / pointCount) * 100),
    5,
    100,
  );
}

export function CenterPanelToolbar() {
  const store = useProjectStoreOptional();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [activeSubtool, setActiveSubtool] = useState<'simplify' | null>(null);
  const [simplifyRetainPercent, setSimplifyRetainPercent] = useState(100);
  const {
    canPlay,
    canSlowDown,
    canSpeedUp,
    distanceLabel,
    isPlaying,
    resetPlayback,
    slowDown,
    speedUp,
    timeLabel,
    togglePlayback,
  } = useAnalysisFlyover();
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const canDeleteActiveRoute = Boolean(
    activeItinerary && (
      (activeItinerary.gpxRoute?.points.length ?? 0) > 0 ||
      activeItinerary.timeline.some((item) =>
        item.kind === 'waypoint' ||
        item.kind === 'pause' ||
        item.kind === 'poi' ||
        item.lat != null ||
        item.lon != null ||
        (item.kind === 'start' && item.label !== 'Rechercher un lieu') ||
        (item.kind === 'end' && item.label !== 'Rechercher un lieu'),
      ) ||
      activeItinerary.metrics ||
      activeItinerary.poiFeatures?.length ||
      activeItinerary.prediction
    ),
  );
  const handleDeleteActiveRoute = () => {
    if (!store || !activeItinerary) return;
    store.clearItineraryRoute(activeItinerary.id);
  };
  const simplifiableRoute =
    activeItinerary?.gpxRoute && activeItinerary.gpxRoute.source !== 'brouter'
      ? activeItinerary.gpxRoute
      : null;
  const activeTracePointCount = simplifiableRoute?.points.length ?? 0;
  const canSimplifyTrace = activeTracePointCount > 2;
  const simplifyTargetPoints = useMemo(
    () =>
      clamp(
        Math.round(activeTracePointCount * (simplifyRetainPercent / 100)),
        2,
        Math.max(2, activeTracePointCount),
      ),
    [activeTracePointCount, simplifyRetainPercent],
  );
  const canApplySimplification = canSimplifyTrace && simplifyTargetPoints < activeTracePointCount;

  useEffect(() => {
    setSimplifyRetainPercent(computeDefaultRetainPercent(activeTracePointCount));
  }, [activeItinerary?.id, activeTracePointCount]);

  useEffect(() => {
    if (!toolsExpanded) {
      setActiveSubtool(null);
    }
  }, [toolsExpanded]);

  const handleToggleTools = () => {
    setToolsExpanded((open) => !open);
  };

  const handleToggleSimplifyTool = () => {
    if (!canSimplifyTrace) return;
    if (!toolsExpanded) {
      setToolsExpanded(true);
      setActiveSubtool('simplify');
      return;
    }
    setActiveSubtool((current) => (current === 'simplify' ? null : 'simplify'));
  };

  const handleApplySimplification = () => {
    if (!store || !activeItinerary || !canApplySimplification) return;
    store.simplifyItineraryGpx(activeItinerary.id, simplifyTargetPoints);
  };

  return (
    <section className="rvc-center-toolbar" aria-label="Barre d'outils centrale">
      <div className="rvc-center-toolbar__viewport">
        <div className="rvc-center-toolbar__track" role="toolbar" aria-label="Outils d'édition du parcours">
          <ToolbarIconButton label="Annuler">
            <IconUndo />
          </ToolbarIconButton>

          <ToolbarIconButton label="Rétablir">
            <IconRedo />
          </ToolbarIconButton>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Sélection">
            <IconCursor size={18} />
          </ToolbarIconButton>

          <button className="rvc-center-toolbar__button rvc-center-toolbar__button--accent" type="button" aria-label="Ajouter" title="Ajouter">
            <IconPlusCircle />
            <span className="rvc-center-toolbar__button-text">Ajouter</span>
            <IconChevronDown size={16} />
          </button>

          <button className="rvc-center-toolbar__button rvc-center-toolbar__button--label" type="button" aria-label="Tracer" title="Tracer">
            <IconPencilLine />
            <span className="rvc-center-toolbar__button-text">Tracer</span>
          </button>

          <div className="rvc-center-toolbar__separator" aria-hidden="true" />

          <ToolbarIconButton label="Inverser">
            <IconSwitchHorizontal />
          </ToolbarIconButton>

          <ToolbarIconButton label="Découper">
            <IconScissors />
          </ToolbarIconButton>

          <ToolbarIconButton label="Symétrie">
            <IconReflectVertical />
          </ToolbarIconButton>

          <ToolbarIconButton label="Courbe de Bézier">
            <IconBezier />
          </ToolbarIconButton>

          <ToolbarIconButton label="Interdire">
            <IconSlashOctagon />
          </ToolbarIconButton>

          <ToolbarIconButton label="Outils" onClick={handleToggleTools} active={toolsExpanded}>
            <IconWrench />
          </ToolbarIconButton>

          <ToolbarIconButton
            label="Supprimer"
            onClick={handleDeleteActiveRoute}
            disabled={!canDeleteActiveRoute}
          >
            <IconTrash />
          </ToolbarIconButton>

          {toolsExpanded ? (
            <ToolbarIconButton
              label="Simplification intelligente de la trace"
              onClick={handleToggleSimplifyTool}
              disabled={!canSimplifyTrace}
              active={activeSubtool === 'simplify'}
            >
              <span className="rvc-center-toolbar__tool-glyph" aria-hidden="true">X</span>
            </ToolbarIconButton>
          ) : null}

          <div className="rvc-center-toolbar__spacer" aria-hidden="true" />

          <div className="rvc-center-toolbar__playback" aria-label="Lecture du parcours">
            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Ralentir le flyover"
              title="Ralentir le flyover"
              onClick={slowDown}
              disabled={!canPlay || !canSlowDown}
            >
              <IconSkip direction="backward" />
            </button>

            <button
              className={
                isPlaying
                  ? 'rvc-center-toolbar__button rvc-center-toolbar__button--play rvc-center-toolbar__button--play-active'
                  : 'rvc-center-toolbar__button rvc-center-toolbar__button--play'
              }
              type="button"
              aria-label={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              title={isPlaying ? 'Mettre en pause le flyover' : 'Lancer le flyover'}
              aria-pressed={isPlaying}
              onClick={togglePlayback}
              disabled={!canPlay}
            >
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Accélérer le flyover"
              title="Accélérer le flyover"
              onClick={speedUp}
              disabled={!canPlay || !canSpeedUp}
            >
              <IconSkip direction="forward" />
            </button>

            <button
              className="rvc-center-toolbar__button"
              type="button"
              aria-label="Revenir au début du flyover"
              title="Revenir au début du flyover"
              onClick={resetPlayback}
              disabled={!canPlay}
            >
              <IconClockRewind />
            </button>

            <div className="rvc-center-toolbar__metrics" aria-label="Résumé de lecture">
              <span>{distanceLabel}</span>
              <span>{timeLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {toolsExpanded && activeSubtool === 'simplify' ? (
        <div className="rvc-center-toolbar__tool-panel" role="group" aria-label="Réduction de points GPX">
          <div className="rvc-center-toolbar__tool-panel-head">
            <span className="rvc-center-toolbar__tool-title">Simplification intelligente</span>
            <span className="rvc-center-toolbar__tool-stats">
              {simplifyTargetPoints.toLocaleString('fr-FR')} / {activeTracePointCount.toLocaleString('fr-FR')} pts
            </span>
          </div>

          <div className="rvc-center-toolbar__tool-panel-row">
            <span className="rvc-center-toolbar__tool-caption">Conserver</span>
            <div className="rvc-center-toolbar__tool-slider-shell">
              <Slider
                value={simplifyRetainPercent}
                min={5}
                max={100}
                step={1}
                width="100%"
                onChange={setSimplifyRetainPercent}
                onCommit={setSimplifyRetainPercent}
              />
            </div>
            <span className="rvc-center-toolbar__tool-value">{simplifyRetainPercent}%</span>
          </div>

          <div className="rvc-center-toolbar__tool-panel-actions">
            <span className="rvc-center-toolbar__tool-caption">
              Réduction: {Math.max(0, 100 - Math.round((simplifyTargetPoints / Math.max(activeTracePointCount, 1)) * 100))}%
            </span>
            <button
              className="rvc-center-toolbar__button rvc-center-toolbar__button--accent"
              type="button"
              onClick={handleApplySimplification}
              disabled={!canApplySimplification}
            >
              Réduire
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}