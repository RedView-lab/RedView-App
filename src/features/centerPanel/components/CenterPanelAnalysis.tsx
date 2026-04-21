import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AnalysisHoverCards,
  defaultAnalysisHoverCards,
  type AnalysisHoverCardData,
} from './AnalysisHoverCards';
import { IconCheck, IconChevronDown, IconMoon, IconSun } from './CenterPanelIcons';
import { AxisDropdown, type AxisOption } from './AxisDropdown';

const filters = ['Waypoint', 'POI', 'Pause', 'Alertes', 'Pente', 'Jour/nuit'];

/** Domain for the X axis (km, may become dynamic later). */
const X_DOMAIN_MIN = 0;
const X_DOMAIN_MAX = 100;
/** Domain for the Y axis (m, may become dynamic later). */
const Y_DOMAIN_MIN = 0;
const Y_DOMAIN_MAX = 3000;

/** Target spacing in CSS px between successive ticks. */
const X_MAJOR_TARGET_PX = 80;
const X_MINOR_TARGET_PX = 28;
const Y_MAJOR_TARGET_PX = 56;
const Y_MINOR_TARGET_PX = 22;

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
  usableHeight: number;
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
    usableHeight,
    heightTier,
  };
}

/**
 * Project a normalized [0..1] anchor (used by hover cards) to an absolute Y
 * pixel coordinate inside the plot. No exaggeration is applied so the value
 * matches the displayed Y grid.
 */
function projectNormalizedY(value: number, metrics: PlotMetrics) {
  const normalized = clampNumber(value, 0, 1);
  return metrics.scaleTop + (1 - normalized) * metrics.usableHeight;
}

/**
 * Compute a "nice" axis tick step (1, 2, 2.5, 5 or 10) × 10ⁿ given a numeric
 * range and a desired tick count. Returns ticks aligned on the chosen step.
 */
function buildNiceTicks(min: number, max: number, targetCount: number): number[] {
  const range = Math.max(1e-9, max - min);
  const desired = Math.max(2, targetCount);
  const rough = range / desired;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow10;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 4) nice = 2.5;
  else if (norm < 7) nice = 5;
  else nice = 10;
  const step = nice * pow10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Number((Math.round(v / step) * step).toFixed(10)));
  }
  if (ticks.length === 0 || ticks[0] > min + step * 1e-6) ticks.unshift(min);
  if (ticks[ticks.length - 1] < max - step * 1e-6) ticks.push(max);
  const seen = new Set<number>();
  return ticks.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
}

/**
 * For each interval between two consecutive {@link majors}, generate evenly
 * spaced subdivisions when the available pixel range allows them.
 */
function buildMinorTicks(
  majors: number[],
  domainMin: number,
  domainMax: number,
  rangePx: number,
  minSpacingPx: number,
): number[] {
  if (majors.length < 2 || rangePx <= 0) return [];
  const span = domainMax - domainMin;
  const intervalPx = (rangePx * (majors[1] - majors[0])) / span;
  const subdivisions = Math.max(0, Math.floor(intervalPx / minSpacingPx) - 1);
  if (subdivisions === 0) return [];
  const minors: number[] = [];
  for (let i = 0; i < majors.length - 1; i++) {
    const seg = (majors[i + 1] - majors[i]) / (subdivisions + 1);
    for (let m = 1; m <= subdivisions; m++) minors.push(majors[i] + seg * m);
  }
  return minors;
}

function formatTickLabel(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(2)).toString();
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
    '--rvc-center-marker-top': `${plotMetrics.markerTop}px`,
  } as CSSProperties;

  const xMajors = useMemo(() => {
    const w = plotMetrics.plotContentWidth;
    if (w <= 0) return buildNiceTicks(X_DOMAIN_MIN, X_DOMAIN_MAX, 5);
    return buildNiceTicks(X_DOMAIN_MIN, X_DOMAIN_MAX, Math.max(2, Math.round(w / X_MAJOR_TARGET_PX)));
  }, [plotMetrics.plotContentWidth]);

  const xMinors = useMemo(
    () => buildMinorTicks(xMajors, X_DOMAIN_MIN, X_DOMAIN_MAX, plotMetrics.plotContentWidth, X_MINOR_TARGET_PX),
    [xMajors, plotMetrics.plotContentWidth],
  );

  const yMajors = useMemo(() => {
    const h = plotMetrics.usableHeight;
    if (h <= 0) return buildNiceTicks(Y_DOMAIN_MIN, Y_DOMAIN_MAX, 4);
    return buildNiceTicks(Y_DOMAIN_MIN, Y_DOMAIN_MAX, Math.max(2, Math.round(h / Y_MAJOR_TARGET_PX)));
  }, [plotMetrics.usableHeight]);

  const yMinors = useMemo(
    () => buildMinorTicks(yMajors, Y_DOMAIN_MIN, Y_DOMAIN_MAX, plotMetrics.usableHeight, Y_MINOR_TARGET_PX),
    [yMajors, plotMetrics.usableHeight],
  );

  const xToPx = (value: number) =>
    plotMetrics.plotGutter + plotMetrics.plotContentWidth * ((value - X_DOMAIN_MIN) / (X_DOMAIN_MAX - X_DOMAIN_MIN));
  const yToPx = (value: number) =>
    plotMetrics.scaleTop + (1 - (value - Y_DOMAIN_MIN) / (Y_DOMAIN_MAX - Y_DOMAIN_MIN)) * plotMetrics.usableHeight;

  const yLabels = yMajors.map((value) => ({
    value,
    label: formatTickLabel(value),
    top: yToPx(value),
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
            className="rvc-center-analysis__grid"
            viewBox={`0 0 ${plotMetrics.plotWidth} ${plotMetrics.plotHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {yMinors.map((value) => {
              const y = yToPx(value);
              return (
                <line
                  key={`ymin-${value}`}
                  x1={plotMetrics.plotGutter}
                  x2={plotMetrics.plotWidth}
                  y1={y}
                  y2={y}
                  className="rvc-center-analysis__grid-line rvc-center-analysis__grid-line--minor"
                />
              );
            })}
            {yMajors.map((value) => {
              const y = yToPx(value);
              return (
                <line
                  key={`ymaj-${value}`}
                  x1={plotMetrics.plotGutter}
                  x2={plotMetrics.plotWidth}
                  y1={y}
                  y2={y}
                  className="rvc-center-analysis__grid-line rvc-center-analysis__grid-line--major"
                />
              );
            })}
            {xMinors.map((value) => {
              const x = xToPx(value);
              return (
                <line
                  key={`xmin-${value}`}
                  x1={x}
                  x2={x}
                  y1={plotMetrics.scaleTop}
                  y2={plotMetrics.plotHeight - plotMetrics.axisBottom}
                  className="rvc-center-analysis__grid-line rvc-center-analysis__grid-line--minor"
                />
              );
            })}
            {xMajors.map((value) => {
              const x = xToPx(value);
              return (
                <line
                  key={`xmaj-${value}`}
                  x1={x}
                  x2={x}
                  y1={plotMetrics.scaleTop}
                  y2={plotMetrics.plotHeight - plotMetrics.axisBottom}
                  className="rvc-center-analysis__grid-line rvc-center-analysis__grid-line--major"
                />
              );
            })}
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
              key={`y-${label.value}`}
              className="rvc-center-analysis__y-label"
              style={{ top: `${label.top}px` }}
            >
              {label.label}
            </div>
          ))}

          <div className="rvc-center-analysis__x-axis">
            {xMajors.map((value) => {
              const ratio = (value - X_DOMAIN_MIN) / (X_DOMAIN_MAX - X_DOMAIN_MIN);
              const isFirst = value === xMajors[0];
              const isLast = value === xMajors[xMajors.length - 1];
              return (
                <span
                  key={`xlbl-${value}`}
                  className="rvc-center-analysis__x-tick"
                  style={{
                    left: `${plotMetrics.plotGutter + plotMetrics.plotContentWidth * ratio}px`,
                    transform: isFirst
                      ? 'translateX(0)'
                      : isLast
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                  }}
                >
                  {formatTickLabel(value)}
                </span>
              );
            })}
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
