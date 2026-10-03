import type { CSSProperties } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { KindBadge } from '../KindBadge';
import {
  CARD_NAME_LINE_HEIGHT_PX,
  CARD_NAME_MAX_LINES,
  RAIL_ITEM_HEIGHT_PX,
} from './constants';
import type { EventSpanSegment, TimelineEvent, TimelineStandalonePause } from './types';
import { formatPauseDuration } from './utils';

interface TimelineEventContinuationProps {
  event: TimelineEvent;
  segment: EventSpanSegment;
  selected: boolean;
  animationDelayMs: number;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
}

/**
 * Suite d'une carte qui passe minuit (nuit à l'hôtel, longue pause) : la
 * plage continue en haut de la colonne du lendemain, avec le même repère
 * (icône, nom) et le reste de la pause dans la colonne des pauses.
 */
export function TimelineEventContinuation({
  event,
  segment,
  selected,
  animationDelayMs,
  resolveColumnPlacement,
}: TimelineEventContinuationProps) {
  const { t } = useAppI18n();
  const title =
    event.item.kind === 'pause' && event.item.durationMin
      ? formatPauseDuration(event.item.durationMin)
      : event.item.label || t('Point sans nom');
  const pauseDurationMin = event.attachedPauses.reduce((total, pause) => total + pause.durationMin, 0);
  const mainHeightPx = Math.min(segment.heightPx, Math.max(RAIL_ITEM_HEIGHT_PX, segment.pauseHeightPx));
  const nameLines = Math.max(1, Math.min(
    CARD_NAME_MAX_LINES,
    Math.floor((mainHeightPx - 8) / CARD_NAME_LINE_HEIGHT_PX),
  ));

  return (
    <div
      className={`rvi-tl-schedule__event-span${selected ? ' is-selected' : ''}`}
      style={{
        top: segment.topPx,
        minHeight: segment.heightPx,
        height: segment.heightPx,
        animationDelay: `${animationDelayMs}ms`,
        '--rvi-tl-name-lines': String(nameLines),
        ...resolveColumnPlacement(segment.dayKey),
      } as CSSProperties}
      data-kind={event.item.kind}
      data-multiline-name={nameLines > 1 ? '' : undefined}
      aria-hidden
    >
      <span className="rvi-tl-schedule__event-main rvi-tl-schedule__event-span-main" style={{ height: mainHeightPx }}>
        <span className="rvi-tl-schedule__event-icon">
          <KindBadge
            kind={event.item.kind}
            poiCategory={event.item.poiCategory}
            favorite={event.item.favorite}
            pauseDurationMin={event.item.durationMin}
            size={24}
          />
        </span>
        <span className="rvi-tl-schedule__event-name" title={title}>
          {title}
        </span>
        <span className="rvi-tl-schedule__event-pauses">
          {segment.pauseHeightPx > 0 ? (
            <span
              className="rvi-tl-schedule__pause-chip is-visible"
              style={{ minHeight: segment.pauseHeightPx, height: segment.pauseHeightPx }}
            >
              <span className="rvi-tl-schedule__pause-chip-icon">
                <KindBadge kind="pause" size={24} />
              </span>
              <span>{formatPauseDuration(pauseDurationMin)}</span>
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

interface TimelinePauseContinuationProps {
  pause: TimelineStandalonePause;
  segment: EventSpanSegment;
  resolveColumnPlacement: (dayKey: string | null) => CSSProperties;
}

/** Suite d'une pause seule qui passe minuit, en haut de la colonne du lendemain. */
export function TimelinePauseContinuation({
  pause,
  segment,
  resolveColumnPlacement,
}: TimelinePauseContinuationProps) {
  return (
    <div
      className={[
        'rvi-tl-schedule__pause',
        'rvi-tl-schedule__pause--standalone',
        'rvi-tl-schedule__pause--continuation',
        pause.visible ? 'is-visible' : '',
      ].filter(Boolean).join(' ')}
      data-source={pause.source}
      style={{
        top: segment.topPx,
        '--rvi-tl-pause-height': `${segment.heightPx}px`,
        ...resolveColumnPlacement(segment.dayKey),
      } as CSSProperties}
      aria-hidden
    >
      <div className="rvi-tl-schedule__pause-card">
        <div className="rvi-tl-schedule__pause-main">
          <span className="rvi-tl-schedule__event-icon">
            <KindBadge kind="pause" size={24} />
          </span>
          <span className="rvi-tl-schedule__pause-chip rvi-tl-schedule__pause-chip--standalone">
            <span>{formatPauseDuration(pause.durationMin)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
