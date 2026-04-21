import { Fragment, type CSSProperties } from 'react';

export interface AnalysisHoverCardMetrics {
  distanceLabel: string;
  ascentLabel: string;
  descentLabel: string;
  durationLabel: string;
  scheduleLabel: string;
}

export interface AnalysisHoverCardData {
  id: string;
  color: string;
  anchorX: number;
  anchorY: number;
  metrics: AnalysisHoverCardMetrics;
}

export interface AnalysisHoverCardsLayout {
  top: number;
  left: number;
  groupWidth: number;
}

interface AnalysisHoverCardsProps {
  cards: AnalysisHoverCardData[];
  layout: AnalysisHoverCardsLayout | null;
}

export const defaultAnalysisHoverCards: AnalysisHoverCardData[] = [
  {
    id: 'route-primary',
    color: '#d10000',
    anchorX: 0.365,
    anchorY: 0.81,
    metrics: {
      distanceLabel: '127.23 km',
      ascentLabel: '+839 m',
      descentLabel: '-420 m',
      durationLabel: '02:48:59',
      scheduleLabel: 'J1 - 08:29',
    },
  },
  {
    id: 'route-reference-a',
    color: '#ffb54a',
    anchorX: 0.525,
    anchorY: 0.72,
    metrics: {
      distanceLabel: '127.23 km',
      ascentLabel: '+1232 m',
      descentLabel: '-339 m',
      durationLabel: '02:31:19',
      scheduleLabel: 'J1 - 08:12',
    },
  },
  {
    id: 'route-reference-b',
    color: '#ffb54a',
    anchorX: 0.675,
    anchorY: 0.67,
    metrics: {
      distanceLabel: '127.23 km',
      ascentLabel: '+1232 m',
      descentLabel: '-339 m',
      durationLabel: '02:31:19',
      scheduleLabel: 'J1 - 08:12',
    },
  },
];

export function AnalysisHoverCards({ cards, layout }: AnalysisHoverCardsProps) {
  if (!layout || cards.length === 0) return null;

  return (
    <div
      className="rvc-center-analysis__hover-cards"
      style={
        {
          top: `${layout.top}px`,
          left: `${layout.left}px`,
          '--rvc-center-hover-group-width': `${layout.groupWidth}px`,
        } as CSSProperties
      }
    >
      {cards.map((card, index) => (
        <Fragment key={card.id}>
          {index > 0 ? <div className="rvc-center-analysis__hover-divider" aria-hidden="true" /> : null}
          <section className="rvc-center-analysis__hover-card">
            <span className="rvc-center-analysis__hover-card-dot" style={{ backgroundColor: card.color }} />
            <div className="rvc-center-analysis__hover-card-copy">
              <div className="rvc-center-analysis__hover-card-value">{card.metrics.distanceLabel}</div>
              <div className="rvc-center-analysis__hover-card-metrics">
                <div>{card.metrics.ascentLabel}</div>
                <div>{card.metrics.descentLabel}</div>
                <div>{card.metrics.durationLabel}</div>
                <div>{card.metrics.scheduleLabel}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}