import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AnalysisHoverCards,
  defaultAnalysisHoverCards,
  type AnalysisHoverCardData,
} from './AnalysisHoverCards';
import { IconCheck, IconChevronDown, IconMoon, IconSun } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];
const xTicks = ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100'];
const axisOptions: AxisOption[] = [
  { value: 'Vitesse', label: 'Vitesse', tone: 'primary' },
  { value: 'Vitesse moyenne', label: 'Vitesse moyenne', tone: 'primary' },
  { value: 'Puissance', label: 'Puissance', tone: 'primary' },
  { value: 'Puissance moyenne', label: 'Puissance moyenne', tone: 'primary' },
  { value: 'Dénivelé', label: 'Dénivelé', tone: 'primary' },
  { value: 'Pente', label: 'Pente', tone: 'primary' },
  { value: 'Surface', label: 'Surface', tone: 'primary' },
  { value: 'Température (°)', label: 'Température (°)', tone: 'secondary' },
  {
    value: 'Température ressentie (°)',
    label: 'Température ressentie (°)',
    tone: 'secondary',
  },
  { value: 'Pluie (mm)', label: 'Pluie (mm)', tone: 'secondary' },
  { value: 'Vent (km/h)', label: 'Vent (km/h)', tone: 'secondary' },
  {
    value: 'Couverture nuageuse (%)',
    label: 'Couverture nuageuse (%)',
    tone: 'secondary',
  },
  { value: 'Humidité (%)', label: 'Humidité (%)', tone: 'secondary' },
  { value: 'Ensoleillement (min)', label: 'Ensoleillement (min)', tone: 'secondary' },
  { value: 'Humidité (%)__bis', label: 'Humidité (%)', tone: 'secondary' },
];

const yAxisLevels = [
  { label: '3000', value: 1 },
  { label: '2000', value: 2 / 3 },
  { label: '1000', value: 1 / 3 },
  { label: '0', value: 0 },
] as const;

const profileSamples = [
  { position: 0, value: 0.18 },
  { position: 0.06, value: 0.34 },
  { position: 0.12, value: 0.52 },
  { position: 0.2, value: 0.68 },
  { position: 0.28, value: 0.54 },
  { position: 0.36, value: 0.82 },
  { position: 0.43, value: 0.63 },
  { position: 0.51, value: 0.57 },
  { position: 0.61, value: 0.76 },
  { position: 0.7, value: 0.46 },
  { position: 0.79, value: 0.69 },
  { position: 0.88, value: 0.38 },
  { position: 0.94, value: 0.58 },
  { position: 1, value: 0.31 },
] as const;

type HeightTier = 'xs' | 'sm' | 'md' | 'lg';

interface PlotMetrics {
  plotWidth: number;
  plotHeight: number;
  plotGutter: number;
  plotContentWidth: number;
  overlayTop: number;
  scaleTop: number;
  axisBottom: number;
  bandBottom: number;
  markerTop: number;
  gridStep: number;
  usableHeight: number;
  verticalScale: number;
  heightTier: HeightTier;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getHeightTier(plotHeight: number): HeightTier {
  if (plotHeight < 160) return 'xs';
  if (plotHeight < 220) return 'sm';
  if (plotHeight < 300) return 'md';
  return 'lg';
}

function getVerticalScale(heightTier: HeightTier) {
  switch (heightTier) {
    case 'xs':
      return 0.92;
    case 'sm':
      return 0.98;
    case 'md':
      return 1.06;
    case 'lg':
      return 1.14;
  }
}

function createPlotMetrics(plotWidth: number, plotHeight: number): PlotMetrics {
  const safeWidth = Math.max(320, Math.round(plotWidth));
  const safeHeight = Math.max(140, Math.round(plotHeight));
  const heightTier = getHeightTier(safeHeight);
  const plotGutter = Math.round(clampNumber(safeWidth * 0.0725, 56, 95));
  const plotContentWidth = Math.max(0, safeWidth - plotGutter);
  const overlayTop = Math.round(clampNumber(safeHeight * 0.07, 14, 24));
  const scaleTop = Math.round(clampNumber(safeHeight * 0.14, 28, 40));
  const axisBottom = Math.round(
    clampNumber(safeHeight * (heightTier === 'xs' ? 0.17 : heightTier === 'sm' ? 0.15 : 0.135), 30, 44),
  );
  const bandBottom = axisBottom + Math.round(clampNumber(safeHeight * 0.07, 14, 20));
  const usableHeight = Math.max(72, safeHeight - scaleTop - axisBottom);
  const gridStep = usableHeight / 3;
  const markerTop = Math.max(8, overlayTop - Math.round(clampNumber(safeHeight * 0.025, 4, 8)));

  return {
    plotWidth: safeWidth,
    plotHeight: safeHeight,
    plotGutter,
    plotContentWidth,
    overlayTop,
    scaleTop,
    axisBottom,
    bandBottom,
    markerTop,
    gridStep,
    usableHeight,
    verticalScale: getVerticalScale(heightTier),
    heightTier,
  };
}

function projectNormalizedY(
  value: number,
  metrics: PlotMetrics,
  exaggeration = metrics.verticalScale,
) {
  const normalizedValue = clampNumber(value, 0, 1);
  const scaledValue = clampNumber((normalizedValue - 0.5) * exaggeration + 0.5, 0, 1);
  return metrics.scaleTop + (1 - scaledValue) * metrics.usableHeight;
}

function buildProfilePaths(metrics: PlotMetrics) {
  const points = profileSamples.map((sample) => {
    const x = metrics.plotGutter + metrics.plotContentWidth * sample.position;
    const y = projectNormalizedY(sample.value, metrics);
    return { x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const baselineY = metrics.plotHeight - metrics.axisBottom;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPath = `${linePath} L ${lastPoint.x.toFixed(2)} ${baselineY.toFixed(2)} L ${firstPoint.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;

  return { areaPath, linePath };
}

interface CenterPanelAnalysisProps {
  hoverCards?: AnalysisHoverCardData[];
}

export function CenterPanelAnalysis({ hoverCards = defaultAnalysisHoverCards }: CenterPanelAnalysisProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [openAxis, setOpenAxis] = useState<'axis1' | 'axis2' | null>(null);
  const [axis1Value, setAxis1Value] = useState('Dénivelé');
  const [axis2Value, setAxis2Value] = useState('');
  const [plotMetrics, setPlotMetrics] = useState<PlotMetrics>(() => createPlotMetrics(960, 232));

  useEffect(() => {
    if (!openAxis) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      setOpenAxis(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openAxis]);

  useEffect(() => {
    const plotElement = plotRef.current;
    if (!plotElement) return;

    const updateMetrics = (nextWidth: number, nextHeight: number) => {
      const roundedWidth = Math.round(nextWidth);
      const roundedHeight = Math.round(nextHeight);

      setPlotMetrics((current) => {
        if (current.plotWidth === roundedWidth && current.plotHeight === roundedHeight) {
          return current;
        }

        return createPlotMetrics(roundedWidth, roundedHeight);
      });
    };

    updateMetrics(plotElement.clientWidth, plotElement.clientHeight);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateMetrics(entry.contentRect.width, entry.contentRect.height);
    });

    resizeObserver.observe(plotElement);
    return () => resizeObserver.disconnect();
  }, []);

  const toggleAxis = (axis: 'axis1' | 'axis2') => {
    setOpenAxis((current) => (current === axis ? null : axis));
  };

  const selectAxis1 = (value: string) => {
    setAxis1Value(value.replace('__bis', ''));
    setOpenAxis(null);
  };

  const selectAxis2 = (value: string) => {
    setAxis2Value(value.replace('__bis', ''));
    setOpenAxis(null);
  };

  const analysisStyle = {
    '--rvc-center-plot-gutter': `${plotMetrics.plotGutter}px`,
    '--rvc-center-plot-width': `${plotMetrics.plotContentWidth}px`,
    '--rvc-center-plot-overlay-top': `${plotMetrics.overlayTop}px`,
    '--rvc-center-plot-scale-top': `${plotMetrics.scaleTop}px`,
    '--rvc-center-plot-axis-bottom': `${plotMetrics.axisBottom}px`,
    '--rvc-center-plot-band-bottom': `${plotMetrics.bandBottom}px`,
    '--rvc-center-grid-step': `${plotMetrics.gridStep}px`,
    '--rvc-center-marker-top': `${plotMetrics.markerTop}px`,
  } as CSSProperties;

  const yLabels = yAxisLevels.map((level) => ({
    ...level,
    top: projectNormalizedY(level.value, plotMetrics, 1),
  }));

  const tooltipVerticalOffset =
    plotMetrics.heightTier === 'xs' ? 48 : plotMetrics.heightTier === 'sm' ? 56 : 64;

  const hoverCardGap = 10;
  const hoverCardDividerWidth = 1;
  const hoverCardHorizontalPadding = 20;
  const hoverCardCount = Math.max(hoverCards.length, 1);
  const hoverCardGroupWidth = clampNumber(
    (plotMetrics.plotContentWidth - hoverCardHorizontalPadding - (hoverCardGap + hoverCardDividerWidth) * (hoverCardCount - 1)) /
      hoverCardCount,
    88,
    112,
  );
  const hoverCardsWidth =
    hoverCards.length * hoverCardGroupWidth +
    Math.max(hoverCards.length - 1, 0) * (hoverCardGap + hoverCardDividerWidth) +
    hoverCardHorizontalPadding;
  const hoverCardMinLeft = plotMetrics.plotGutter + 8;
  const hoverCardMaxLeft = plotMetrics.plotGutter + plotMetrics.plotContentWidth - hoverCardsWidth - 8;
  const hoverCardsLayout =
    hoverCards.length > 0
      ? {
          top: clampNumber(
            Math.min(
              ...hoverCards.map((card) => projectNormalizedY(card.anchorY, plotMetrics) - tooltipVerticalOffset),
            ),
            plotMetrics.overlayTop + 6,
            plotMetrics.scaleTop + plotMetrics.usableHeight * 0.45,
          ),
          left: clampNumber(
            plotMetrics.plotGutter + plotMetrics.plotContentWidth * hoverCards[0].anchorX + 2,
            hoverCardMinLeft,
            Math.max(hoverCardMinLeft, hoverCardMaxLeft),
          ),
          groupWidth: hoverCardGroupWidth,
        }
      : null;

  const { areaPath, linePath } = buildProfilePaths(plotMetrics);

  return (
    <section
      ref={rootRef}
      className="rvc-center-analysis"
      aria-label="Analyse du parcours"
      data-height-tier={plotMetrics.heightTier}
      style={analysisStyle}
    >
      <div className="rvc-center-analysis__toolbar">
        <div className="rvc-center-analysis__label">Analyse</div>

        <div className="rvc-center-analysis__segmented" role="tablist" aria-label="Mode d'analyse">
          <button className="rvc-center-analysis__segment rvc-center-analysis__segment--active" type="button">
            Distance
          </button>
          <button className="rvc-center-analysis__segment" type="button">
            Temps
          </button>
        </div>

        <div className="rvc-center-analysis__detail">
          <span className="rvc-center-analysis__minor-label">Détail</span>
          <div className="rvc-center-analysis__slider-group" aria-hidden="true">
            <span>-</span>
            <div className="rvc-center-analysis__slider">
              <div className="rvc-center-analysis__slider-fill" />
              <div className="rvc-center-analysis__slider-thumb" />
            </div>
            <span>+</span>
          </div>
        </div>

        <AxisDropdown
          axisLabel="Axe 1"
          value={axis1Value}
          isOpen={openAxis === 'axis1'}
          options={axisOptions}
          onToggle={() => toggleAxis('axis1')}
          onSelect={selectAxis1}
        />

        <AxisDropdown
          axisLabel="Axe 2"
          value={axis2Value}
          isOpen={openAxis === 'axis2'}
          options={axisOptions}
          onToggle={() => toggleAxis('axis2')}
          onSelect={selectAxis2}
        />

        <div className="rvc-center-analysis__separator" aria-hidden="true" />

        <div className="rvc-center-analysis__filters" aria-label="Filtres">
          {filters.map((filter) => (
            <label key={filter} className="rvc-center-analysis__filter-chip">
              <span className="rvc-center-analysis__checkbox" aria-hidden="true">
                <IconCheck size={10} />
              </span>
              <span className="rvc-center-analysis__filter-label" title={filter}>{filter}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="rvc-center-analysis__chart-shell">
        <div ref={plotRef} className="rvc-center-analysis__plot">
          <div className="rvc-center-analysis__band rvc-center-analysis__band--left" />
          <div className="rvc-center-analysis__band rvc-center-analysis__band--right" />

          <svg
            className="rvc-center-analysis__profile"
            viewBox={`0 0 ${plotMetrics.plotWidth} ${plotMetrics.plotHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="rvc-center-analysis__profile-area" d={areaPath} />
            <path className="rvc-center-analysis__profile-line" d={linePath} />
          </svg>

          <div className="rvc-center-analysis__focus-line" />

          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--sun-left" aria-hidden="true">
            <IconSun size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--moon-left" aria-hidden="true">
            <IconMoon size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--sun-right" aria-hidden="true">
            <IconSun size={12} />
          </div>
          <div className="rvc-center-analysis__marker rvc-center-analysis__marker--moon-right" aria-hidden="true">
            <IconMoon size={12} />
          </div>

          <AnalysisHoverCards cards={hoverCards} layout={hoverCardsLayout} />

          {yLabels.map((label) => (
            <div
              key={label.label}
              className="rvc-center-analysis__y-label"
              style={{ top: `${label.top}px` }}
            >
              {label.label}
            </div>
          ))}

          <div className="rvc-center-analysis__x-axis">
            {xTicks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
        </div>

        <div className="rvc-center-analysis__footer">
          <button className="rvc-center-analysis__add-button" type="button">
            <span className="rvc-center-analysis__add-plus">+</span>
            <span>Ajouter</span>
            <IconChevronDown size={14} />
          </button>
        </div>

        <div className="rvc-center-analysis__scrollbar" aria-hidden="true">
          <div className="rvc-center-analysis__scrollbar-track" />
          <div className="rvc-center-analysis__scrollbar-thumb" />
          <div className="rvc-center-analysis__scrollbar-grip">...</div>
        </div>
      </div>
    </section>
  );
}
