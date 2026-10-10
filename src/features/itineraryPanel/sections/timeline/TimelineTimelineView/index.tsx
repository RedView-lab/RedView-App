/**
 * Agenda (vue d'id `'timeline'`) — vue de planning de la journée.
 *
 * Au lieu d'un simple rail kilométrique, la vue projette les points de contrôle
 * de l'itinéraire sur un canevas jour/heure à l'aide de la prédiction FIT quand
 * elle existe. Les distances pilotent encore le placement de repli et les
 * repères kilométriques, mais l'utilisateur navigue désormais dans une bande de
 * dates et lit le parcours comme des points de contrôle planifiés.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useHasChanged } from '@/shared/hooks/useHasChanged';
import {
  BASE_HOUR_ROW_HEIGHT_PX,
  CARD_COMPACT_MIN_WIDTH_PX,
  CARD_REGULAR_MIN_WIDTH_PX,
  DAY_WINDOW_DAYS,
  MINUTES_PER_DAY,
  SCHEDULE_RAIL_WIDTH_PX,
  SINGLE_DAY_CARD_MAX_WIDTH_PX,
  TIMELINE_VIEWPORT_BOTTOM_INSET_PX,
  TIMELINE_VIEWPORT_TOP_INSET_PX,
} from './constants';
import { TimelineScheduleCanvas } from './TimelineScheduleCanvas';
import { TimelineScheduleHeader } from './TimelineScheduleHeader';
import type { TimelineTimelineViewProps } from './types';
import {
  addDays,
  buildDayWindow,
  buildKmMarkers,
  buildPauseAttachment,
  buildScheduledTimelineState,
  buildScheduledEvents,
  buildScheduledStandalonePauses,
  distanceAtElapsedSeconds,
  minuteToCanvasTopPx,
  parseDayKey,
  parseStartReference,
  positionTimelineBlocks,
  resolveMarkerKmStep,
  resolveRideElapsedSecondsAtScheduledElapsed,
  toDayKey,
} from './utils';

/** Zoom minimal « normal » (boutons, barre) tant que la journée ne tient pas déjà à l'écran. */
const HOUR_ZOOM_MIN = 0.4;

type CardDensity = 'regular' | 'compact' | 'tight';

function resolveCardDensity(cardWidthPx: number): CardDensity {
  if (cardWidthPx >= CARD_REGULAR_MIN_WIDTH_PX) return 'regular';
  if (cardWidthPx >= CARD_COMPACT_MIN_WIDTH_PX) return 'compact';
  return 'tight';
}
const HOUR_ZOOM_MAX = 3.0;
/** Plancher absolu, atteint seulement par le « tout voir » de la barre verticale. */
const HOUR_ZOOM_FLOOR = 0.05;
const NAVIGATOR_MIN_FRACTION = 0.04;
const CANVAS_INSETS_PX = TIMELINE_VIEWPORT_TOP_INSET_PX + TIMELINE_VIEWPORT_BOTTOM_INSET_PX;
/** Écart minimal entre deux graduations horaires (libellé de 18 px + air). */
const HOUR_LABEL_MIN_SPACING_PX = 24;
const HOUR_LABEL_STEPS_H = [1, 2, 3, 4, 6, 12, 24];

export function TimelineTimelineView({
  items,
  visibleIds,
  rhythm,
  prediction,
  config,
  markerStepKm,
  hourZoom = 1,
  onHourZoomChange,
  selectedIds,
  filters,
  onSelectRow,
  onToggleSelect,
  onToggleVisibility,
  onMovePause,
  onChangePauseDuration,
  onChangeIntervalPauseDuration,
  onRegisterPauseInsertionResolver,
  onToggleFavorite,
  onRename,
  onRemove,
}: TimelineTimelineViewProps) {
  const [localHourZoom, setLocalHourZoom] = useState(hourZoom);
  // Zoom changé par le parent : repris pendant le rendu.
  const hourZoomChanged = useHasChanged(hourZoom);
  if (hourZoomChanged && Number.isFinite(hourZoom)) setLocalHourZoom(hourZoom);

  // Le plancher descend sous HOUR_ZOOM_MIN quand la barre verticale demande
  // « tout voir » : il faut alors pouvoir rentrer la journée entière.
  const normalizedHourZoom = Math.min(HOUR_ZOOM_MAX, Math.max(HOUR_ZOOM_FLOOR, localHourZoom));
  const scheduleRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isNavigatingRef = useRef(false);
  // Offset (1 = haut, 0 = bas) à appliquer une fois le canevas re-rendu au nouveau zoom.
  const pendingScrollOffsetRef = useRef<number | null>(null);

  const reference = useMemo(() => parseStartReference(rhythm), [rhythm]);
  const scheduleState = useMemo(
    () => buildScheduledTimelineState(items, prediction, reference, rhythm),
    [items, prediction, reference, rhythm],
  );
  const stopAnchors = scheduleState.stopAnchors;

  // Affichage seulement : le planning ci-dessus reste calculé sur tous les items.
  const timedItems = useMemo(
    () => (visibleIds
      ? scheduleState.timedItems.filter((entry) => visibleIds.has(entry.item.id))
      : scheduleState.timedItems),
    [scheduleState.timedItems, visibleIds],
  );
  const autoPauseItems = useMemo(
    () => (visibleIds
      ? scheduleState.autoPauses.filter(
          (pause) => pause.source !== 'favorite-poi'
            || !pause.attachedToItemId
            || visibleIds.has(pause.attachedToItemId),
        )
      : scheduleState.autoPauses),
    [scheduleState.autoPauses, visibleIds],
  );

  const defaultAnchorDay = useMemo(() => {
    const activeAutoPauses = filters && !filters.pause ? [] : scheduleState.autoPauses;
    const firstDatedItem = [...scheduleState.timedItems, ...activeAutoPauses].find((item) => item.dayKey);
    if (firstDatedItem?.date) return new Date(firstDatedItem.date);
    if (reference.reference && reference.hasRealDate) return new Date(reference.reference);
    return new Date();
  }, [filters, reference, scheduleState.autoPauses, scheduleState.timedItems]);
  const defaultAnchorDayKey = useMemo(() => toDayKey(defaultAnchorDay), [defaultAnchorDay]);

  const [selectedDayKey, setSelectedDayKey] = useState(() => defaultAnchorDayKey);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [multiDayCardDensity, setMultiDayCardDensity] = useState<CardDensity>('regular');
  const [singleDayCardDensity, setSingleDayCardDensity] = useState<CardDensity>('regular');
  const [now, setNow] = useState(() => new Date());
  // Jour d'ancrage changé (nouveau planning) : la sélection y revient (pendant le rendu).
  const defaultAnchorDayKeyChanged = useHasChanged(defaultAnchorDayKey);
  if (defaultAnchorDayKeyChanged) setSelectedDayKey(defaultAnchorDayKey);

  useEffect(() => {
    const node = scheduleRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // 6 jours seulement si chaque colonne garde une carte lisible ; sinon 1 jour.
      const canvasWidthPx = Math.max(0, entry.contentRect.width - SCHEDULE_RAIL_WIDTH_PX);
      const multiDayCardWidthPx = canvasWidthPx / DAY_WINDOW_DAYS;
      setIsCompactLayout(multiDayCardWidthPx < CARD_COMPACT_MIN_WIDTH_PX);
      setMultiDayCardDensity(resolveCardDensity(multiDayCardWidthPx));
      setSingleDayCardDensity(resolveCardDensity(Math.min(canvasWidthPx, SINGLE_DAY_CARD_MAX_WIDTH_PX)));
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  const selectedDayDate = useMemo(
    () => parseDayKey(selectedDayKey) ?? defaultAnchorDay,
    [defaultAnchorDay, selectedDayKey],
  );

  const dayWindow = useMemo(() => buildDayWindow(selectedDayDate), [selectedDayDate]);
  const headerDays = useMemo(() => dayWindow, [dayWindow]);
  const displayDays = useMemo(() => {
    if (!reference.hasRealDate || isCompactLayout) return [selectedDayDate];
    return dayWindow;
  }, [dayWindow, isCompactLayout, reference.hasRealDate, selectedDayDate]);
  const displayDayKeys = useMemo(() => displayDays.map((day) => toDayKey(day)), [displayDays]);
  const displayDayKeySet = useMemo(() => new Set(displayDayKeys), [displayDayKeys]);
  // + la veille du premier jour affiché : ce qui y commence et passe minuit
  // (nuit à l'hôtel, longue pause) continue en haut du premier jour.
  const scheduledDayKeySet = useMemo(() => {
    const keys = new Set(displayDayKeys);
    const firstDay = displayDays[0];
    if (firstDay) keys.add(toDayKey(addDays(firstDay, -1)));
    return keys;
  }, [displayDayKeys, displayDays]);
  const dayIndexByKey = useMemo(
    () => new Map(displayDayKeys.map((dayKey, index) => [dayKey, index])),
    [displayDayKeys],
  );
  const dayColumnCount = Math.max(1, displayDays.length);

  const primaryItems = useMemo(
    () => timedItems.filter((entry) => entry.item.kind !== 'pause'),
    [timedItems],
  );
  const pauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    return timedItems.filter((entry) => entry.item.kind === 'pause');
  }, [filters, timedItems]);

  const filteredPrimaryItems = useMemo(() => {
    if (!reference.hasRealDate) return primaryItems;
    return primaryItems.filter((entry) => entry.dayKey && scheduledDayKeySet.has(entry.dayKey));
  }, [primaryItems, reference.hasRealDate, scheduledDayKeySet]);

  const filteredPauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    if (!reference.hasRealDate) return pauseItems;
    return pauseItems.filter((entry) => entry.dayKey && scheduledDayKeySet.has(entry.dayKey));
  }, [filters, pauseItems, reference.hasRealDate, scheduledDayKeySet]);

  const filteredAutoPauseItems = useMemo(() => {
    if (filters && !filters.pause) return [];
    if (!reference.hasRealDate) return autoPauseItems;
    return autoPauseItems.filter((entry) => entry.dayKey && scheduledDayKeySet.has(entry.dayKey));
  }, [autoPauseItems, filters, reference.hasRealDate, scheduledDayKeySet]);

  const pauseAttachment = useMemo(
    () => buildPauseAttachment(filteredPrimaryItems, filteredAutoPauseItems),
    [filteredAutoPauseItems, filteredPrimaryItems],
  );

  const maxDistanceKm = useMemo(
    () => items.reduce((maxDistance, item) => Math.max(maxDistance, item.distanceKm ?? 0), 0),
    [items],
  );

  const startMinutes = useMemo(() => {
    // Sortie sur plusieurs jours : chaque colonne est une journée entière
    // (minuit → minuit), pour qu'un bloc qui passe minuit continue en haut du
    // lendemain et que la nuit (0 h → heure de départ) reste visible.
    if (reference.hasRealDate && reference.reference) {
      const departureDayKey = toDayKey(reference.reference);
      const spansSeveralDays = [...scheduleState.timedItems, ...scheduleState.autoPauses].some(
        (entry) => entry.dayKey !== null && entry.dayKey !== departureDayKey,
      );
      if (spansSeveralDays) return 0;
    }
    return Math.max(0, Math.floor(reference.startMinutes / 60) * 60);
  }, [reference.hasRealDate, reference.reference, reference.startMinutes, scheduleState.autoPauses, scheduleState.timedItems]);

  const endMinutes = useMemo(() => {
    // Hauteur du canevas stable quels que soient les filtres.
    const lastItemMinute = [...scheduleState.timedItems, ...scheduleState.autoPauses].reduce(
      (maxMinute, item) => Math.max(maxMinute, item.minuteOfDay),
      startMinutes,
    );
    const roundedLastMinute = Math.ceil(lastItemMinute / 60) * 60;
    return Math.max(startMinutes + 12 * 60, MINUTES_PER_DAY, roundedLastMinute);
  }, [scheduleState.autoPauses, scheduleState.timedItems, startMinutes]);

  const visibleDurationMinutes = Math.max(60, endMinutes - startMinutes);
  const hourRowHeightPx = BASE_HOUR_ROW_HEIGHT_PX * normalizedHourZoom;
  const pixelsPerMinute = hourRowHeightPx / 60;
  const canvasBaseHeight = Math.max(visibleDurationMinutes * pixelsPerMinute, 0);
  // Minuit sur le canevas : avec des dates réelles, aucune carte ne le dépasse.
  const dayEndPx = reference.hasRealDate ? minuteToCanvasTopPx(MINUTES_PER_DAY, startMinutes, pixelsPerMinute) : null;

  const scheduledEvents = useMemo(
    () =>
      buildScheduledEvents(
        filteredPrimaryItems,
        pauseAttachment,
        pixelsPerMinute,
        displayDays,
        reference,
        startMinutes,
      ),
    [displayDays, filteredPrimaryItems, pauseAttachment, pixelsPerMinute, reference, startMinutes],
  );

  const scheduledStandalonePauses = useMemo(
    () =>
      buildScheduledStandalonePauses(
        filteredPauseItems,
        pauseAttachment.unattachedPauses,
        filteredPrimaryItems,
        pixelsPerMinute,
        startMinutes,
        displayDays,
        reference.hasRealDate,
      ),
    [
      displayDays,
      filteredPauseItems,
      filteredPrimaryItems,
      pauseAttachment.unattachedPauses,
      pixelsPerMinute,
      reference.hasRealDate,
      startMinutes,
    ],
  );

  const standalonePauseDayKeyById = useMemo(
    () =>
      new Map(
        [
          ...filteredPauseItems.map((pause) => [pause.item.id, pause.dayKey ?? null] as const),
          ...pauseAttachment.unattachedPauses.map((pause) => [pause.id, pause.dayKey ?? null] as const),
        ],
      ),
    [filteredPauseItems, pauseAttachment.unattachedPauses],
  );

  const { events, standalonePauses, canvasHeight, firstVisibleTopPx } = useMemo(
    () =>
      positionTimelineBlocks(
        scheduledEvents,
        scheduledStandalonePauses,
        standalonePauseDayKeyById,
        canvasBaseHeight,
        dayEndPx,
      ),
    [canvasBaseHeight, dayEndPx, scheduledEvents, scheduledStandalonePauses, standalonePauseDayKeyById],
  );

  const kmMarkerStep = useMemo(
    () => resolveMarkerKmStep(config, markerStepKm),
    [config, markerStepKm],
  );
  const handleMovePauseScheduled = useCallback(
    (id: string, scheduledElapsedSeconds: number) => {
      if (!prediction) return;
      const rideElapsedSeconds = resolveRideElapsedSecondsAtScheduledElapsed(
        scheduledElapsedSeconds,
        stopAnchors.filter((anchor) => anchor.id !== id),
      );
      const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
      if (!Number.isFinite(distanceM)) return;
      onMovePause?.(id, Math.max(0, (distanceM as number) / 1000));
    },
    [onMovePause, prediction, stopAnchors],
  );

  const resolveVisiblePauseInsertionDistanceKm = useCallback(() => {
    if (!prediction) return null;

    const viewport = viewportRef.current;
    if (!viewport) return null;

    const rawTopPx = viewport.scrollTop + (viewport.clientHeight > 0 ? viewport.clientHeight * 0.5 : 0);
    const minTopPx = TIMELINE_VIEWPORT_TOP_INSET_PX;
    const maxTopPx = Math.max(minTopPx, canvasHeight - TIMELINE_VIEWPORT_BOTTOM_INSET_PX);
    const topPx = Math.min(maxTopPx, Math.max(minTopPx, rawTopPx));
    const minuteOfDay = Math.min(
      MINUTES_PER_DAY,
      Math.max(
        0,
        startMinutes + ((topPx - TIMELINE_VIEWPORT_TOP_INSET_PX) / Math.max(pixelsPerMinute, 0.001)),
      ),
    );

    let scheduledElapsedSeconds = Math.max(0, (minuteOfDay - startMinutes) * 60);
    if (reference.reference && reference.hasRealDate) {
      const scheduledDate = new Date(
        selectedDayDate.getFullYear(),
        selectedDayDate.getMonth(),
        selectedDayDate.getDate(),
        0,
        0,
        0,
        0,
      );
      scheduledDate.setMinutes(minuteOfDay, 0, 0);
      scheduledElapsedSeconds = Math.max(
        0,
        (scheduledDate.getTime() - reference.reference.getTime()) / 1000,
      );
    }

    const rideElapsedSeconds = resolveRideElapsedSecondsAtScheduledElapsed(
      scheduledElapsedSeconds,
      stopAnchors,
    );
    const distanceM = distanceAtElapsedSeconds(prediction, rideElapsedSeconds);
    if (!Number.isFinite(distanceM)) return null;

    return Math.max(0, Number((((distanceM as number) / 1000)).toFixed(3)));
  }, [canvasHeight, pixelsPerMinute, prediction, reference, selectedDayDate, startMinutes, stopAnchors]);

  useEffect(() => {
    onRegisterPauseInsertionResolver?.(resolveVisiblePauseInsertionDistanceKm);
    return () => onRegisterPauseInsertionResolver?.(null);
  }, [onRegisterPauseInsertionResolver, resolveVisiblePauseInsertionDistanceKm]);

  // Zoom bas (« tout voir ») : une heure peut ne faire que quelques pixels, on
  // espace alors graduations et lignes de grille de 2, 3, 4… heures.
  const hourStepMinutes = useMemo(
    () => (HOUR_LABEL_STEPS_H.find((step) => step * hourRowHeightPx >= HOUR_LABEL_MIN_SPACING_PX) ?? 24) * 60,
    [hourRowHeightPx],
  );

  const hourMarks = useMemo(
    () => {
      const marks: number[] = [];
      for (let minute = startMinutes; minute < endMinutes; minute += hourStepMinutes) {
        marks.push(minute);
      }
      marks.push(endMinutes);
      return marks;
    },
    [endMinutes, hourStepMinutes, startMinutes],
  );

  // La dernière borne n'est étiquetée que si elle ne touche pas la précédente.
  const hourLabelMarks = useMemo(() => {
    if (hourMarks.length < 2) return hourMarks;
    const last = hourMarks[hourMarks.length - 1]!;
    const previous = hourMarks[hourMarks.length - 2]!;
    return (last - previous) * pixelsPerMinute >= HOUR_LABEL_MIN_SPACING_PX
      ? hourMarks
      : hourMarks.slice(0, -1);
  }, [hourMarks, pixelsPerMinute]);

  const kmMarkers = useMemo(
    () =>
      buildKmMarkers(
        items,
        prediction,
        reference,
        displayDayKeySet,
        startMinutes,
        pixelsPerMinute,
        canvasHeight,
        kmMarkerStep,
        maxDistanceKm,
        stopAnchors,
        hourLabelMarks.map((markMinute) => minuteToCanvasTopPx(markMinute, startMinutes, pixelsPerMinute)),
      ),
    [
      canvasHeight,
      displayDayKeySet,
      hourLabelMarks,
      items,
      kmMarkerStep,
      maxDistanceKm,
      pixelsPerMinute,
      prediction,
      reference,
      startMinutes,
      stopAnchors,
    ],
  );

  const currentTimeLineTopPx = useMemo(() => {
    if (!reference.hasRealDate) return null;
    if (!displayDayKeySet.has(toDayKey(now))) return null;
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    if (minuteOfDay < startMinutes || minuteOfDay > endMinutes) return null;
    return minuteToCanvasTopPx(minuteOfDay, startMinutes, pixelsPerMinute);
  }, [displayDayKeySet, endMinutes, now, pixelsPerMinute, reference.hasRealDate, startMinutes]);
  const currentTimeLineDayIndex = useMemo(() => {
    if (!reference.hasRealDate) return null;
    return dayIndexByKey.get(toDayKey(now)) ?? null;
  }, [dayIndexByKey, now, reference.hasRealDate]);

  const [viewportMetrics, setViewportMetrics] = useState({
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });

  const updateViewportMetrics = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    setViewportMetrics({
      clientHeight: vp.clientHeight,
      scrollHeight: vp.scrollHeight,
      scrollTop: vp.scrollTop,
    });
  }, []);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    updateViewportMetrics();
    vp.addEventListener('scroll', updateViewportMetrics, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateViewportMetrics())
      : null;
    ro?.observe(vp);
    return () => {
      vp.removeEventListener('scroll', updateViewportMetrics);
      ro?.disconnect();
    };
  }, [canvasHeight, updateViewportMetrics]);

  // Après un changement de zoom piloté par la barre : on positionne le scroll
  // avant le paint, sur la hauteur réelle du canevas (pas une estimation).
  useLayoutEffect(() => {
    const offset = pendingScrollOffsetRef.current;
    const vp = viewportRef.current;
    if (offset === null || !vp) return;
    pendingScrollOffsetRef.current = null;
    const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
    vp.scrollTop = (1 - offset) * maxScroll;
    updateViewportMetrics();
  });

  useEffect(() => {
    const handleWindowPointerUp = () => {
      isNavigatingRef.current = false;
    };
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, []);

  const verticalFraction = useMemo(() => {
    if (viewportMetrics.scrollHeight <= 0 || viewportMetrics.clientHeight <= 0) return 1;
    return Math.min(
      1,
      Math.max(NAVIGATOR_MIN_FRACTION, viewportMetrics.clientHeight / viewportMetrics.scrollHeight),
    );
  }, [viewportMetrics.clientHeight, viewportMetrics.scrollHeight]);

  const visibleDurationHours = Math.max(1, visibleDurationMinutes / 60);

  // Fraction visible au zoom max : les poignées ne peuvent pas aller en dessous,
  // sinon la barre demanderait un zoom inatteignable et le pouce décrocherait.
  const verticalMinFraction = useMemo(() => {
    if (viewportMetrics.clientHeight <= 0) return NAVIGATOR_MIN_FRACTION;
    const maxZoomCanvasHeight = visibleDurationHours * BASE_HOUR_ROW_HEIGHT_PX * HOUR_ZOOM_MAX + CANVAS_INSETS_PX;
    return Math.min(1, Math.max(NAVIGATOR_MIN_FRACTION, viewportMetrics.clientHeight / maxZoomCanvasHeight));
  }, [viewportMetrics.clientHeight, visibleDurationHours]);

  const verticalOffset = useMemo(() => {
    const maxScroll = Math.max(0, viewportMetrics.scrollHeight - viewportMetrics.clientHeight);
    if (maxScroll <= 0) return 1;
    const ratio = Math.max(0, Math.min(1, viewportMetrics.scrollTop / maxScroll));
    return 1 - ratio;
  }, [viewportMetrics.clientHeight, viewportMetrics.scrollHeight, viewportMetrics.scrollTop]);

  const handleVerticalNavigatorChange = useCallback(
    (next: { visibleFraction: number; offset: number }) => {
      const vp = viewportRef.current;
      if (!vp) return;

      isNavigatingRef.current = true;
      const clientHeight = vp.clientHeight;
      if (clientHeight <= 0) return;

      const clampedFraction = Math.max(NAVIGATOR_MIN_FRACTION, Math.min(1, next.visibleFraction));
      // Offset 1 = haut (scrollTop 0), offset 0 = bas (scrollTop max).
      const clampedOffset = Math.max(0, Math.min(1, next.offset));

      let targetZoom = normalizedHourZoom;
      const wantsFitAll = clampedFraction >= 0.999 && verticalFraction < 0.999;
      if (wantsFitAll || Math.abs(clampedFraction - verticalFraction) > 0.005) {
        // Hauteur canevas = durée × hauteur d'heure × zoom + insets haut/bas.
        const hourPxAtZoom1 = visibleDurationHours * BASE_HOUR_ROW_HEIGHT_PX;
        const zoomForFraction = (fraction: number) => (clientHeight / fraction - CANVAS_INSETS_PX) / hourPxAtZoom1;
        // Zoom auquel la journée entière tient dans la vue (fraction = 1).
        const fitAllZoom = zoomForFraction(1);
        const minZoom = Math.max(HOUR_ZOOM_FLOOR, Math.min(HOUR_ZOOM_MIN, fitAllZoom));
        targetZoom = Math.min(HOUR_ZOOM_MAX, Math.max(minZoom, zoomForFraction(clampedFraction)));
      }

      if (Math.abs(targetZoom - normalizedHourZoom) > 1e-4) {
        // Le scroll sera appliqué après re-rendu, sur la nouvelle hauteur réelle.
        pendingScrollOffsetRef.current = clampedOffset;
        setLocalHourZoom(targetZoom);
        onHourZoomChange?.(targetZoom);
        return;
      }

      const maxScroll = Math.max(0, vp.scrollHeight - clientHeight);
      vp.scrollTop = (1 - clampedOffset) * maxScroll;
      updateViewportMetrics();
    },
    [normalizedHourZoom, onHourZoomChange, updateViewportMetrics, verticalFraction, visibleDurationHours],
  );

  // Double-clic sur la barre : retour au zoom par défaut, en haut de la journée.
  const handleVerticalNavigatorReset = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    isNavigatingRef.current = true;
    if (Math.abs(normalizedHourZoom - 1) > 1e-4) {
      pendingScrollOffsetRef.current = 1;
      setLocalHourZoom(1);
      onHourZoomChange?.(1);
      return;
    }
    vp.scrollTop = 0;
    updateViewportMetrics();
  }, [normalizedHourZoom, onHourZoomChange, updateViewportMetrics]);

  const handleZoomWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTop += e.deltaY;
  }, []);

  const hasInitialAutoScrolledRef = useRef(false);
  const lastAutoScrollDayKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (isNavigatingRef.current) return;

    const daysKey = displayDayKeys.join(',');
    const isNewDay = lastAutoScrollDayKeyRef.current !== daysKey;
    if (!isNewDay && hasInitialAutoScrolledRef.current) return;
    if (canvasHeight <= 0) return;

    lastAutoScrollDayKeyRef.current = daysKey;
    hasInitialAutoScrolledRef.current = true;

    const fallbackTopPx = minuteToCanvasTopPx(reference.startMinutes, startMinutes, pixelsPerMinute);
    const preferredTopPx = currentTimeLineTopPx ?? firstVisibleTopPx ?? fallbackTopPx;
    if (preferredTopPx === null) {
      viewport.scrollTop = 0;
      return;
    }

    const targetScrollTop = Math.max(
      0,
      Math.min(
        preferredTopPx - hourRowHeightPx * 0.5,
        Math.max(0, viewport.scrollHeight - viewport.clientHeight),
      ),
    );
    viewport.scrollTop = targetScrollTop;
  }, [canvasHeight, currentTimeLineTopPx, displayDayKeys, firstVisibleTopPx, hourRowHeightPx, pixelsPerMinute, reference.startMinutes, startMinutes]);

  const visibleWindowHasEvents = events.length > 0 || standalonePauses.length > 0;
  const scheduleStyle = {
    '--rvi-tl-day-count': String(dayColumnCount),
    '--rvi-tl-hour-row-height': `${hourRowHeightPx}px`,
  } as CSSProperties;
  const canvasStyle = {
    height: canvasHeight,
  } as CSSProperties;

  function resolveColumnPlacement(dayKey: string | null): CSSProperties {
    if (!reference.hasRealDate || dayColumnCount <= 1) return {};
    const dayIndex = dayKey ? dayIndexByKey.get(dayKey) : undefined;
    const normalizedIndex = dayIndex ?? 0;
    const columnWidthPct = 100 / dayColumnCount;
    return {
      left: `${normalizedIndex * columnWidthPct}%`,
      width: `${columnWidthPct}%`,
      right: 'auto',
    };
  }

  function resolveNowLinePlacement(): CSSProperties {
    if (!reference.hasRealDate || dayColumnCount <= 1 || currentTimeLineDayIndex === null) {
      return {};
    }
    const columnWidthPct = 100 / dayColumnCount;
    return {
      left: `${currentTimeLineDayIndex * columnWidthPct}%`,
      width: `${columnWidthPct}%`,
      right: 'auto',
    };
  }

  return (
    <div
      ref={scheduleRef}
      className="rvi-tl-schedule"
      style={scheduleStyle}
      data-layout={dayColumnCount > 1 ? 'multi-day' : 'single-day'}
      data-density={dayColumnCount > 1 ? multiDayCardDensity : singleDayCardDensity}
      aria-label="Agenda journalier"
    >
      <TimelineScheduleHeader
        displayDays={headerDays}
        selectedDayKey={selectedDayKey}
        onSelectDay={setSelectedDayKey}
      />

      <TimelineScheduleCanvas
        viewportRef={viewportRef}
        verticalFraction={verticalFraction}
        verticalOffset={verticalOffset}
        verticalMinFraction={Math.min(verticalMinFraction, verticalFraction)}
        onVerticalNavigatorChange={handleVerticalNavigatorChange}
        onVerticalNavigatorReset={handleVerticalNavigatorReset}
        onZoomWheel={handleZoomWheel}
        hourMarks={hourMarks}
        hourLabelMarks={hourLabelMarks}
        hourRowHeightPx={hourRowHeightPx}
        kmMarkers={kmMarkers}
        canvasStyle={canvasStyle}
        displayDays={displayDays}
        selectedDayKey={selectedDayKey}
        currentTimeLineTopPx={currentTimeLineTopPx}
        now={now}
        visibleWindowHasEvents={visibleWindowHasEvents}
        events={events}
        standalonePauses={standalonePauses}
        standalonePauseDayKeyById={standalonePauseDayKeyById}
        reference={reference}
        startMinutes={startMinutes}
        pixelsPerMinute={pixelsPerMinute}
        canvasHeight={canvasHeight}
        selectedIds={selectedIds}
        onSelectRow={onSelectRow}
        onToggleSelect={onToggleSelect}
        onToggleVisibility={onToggleVisibility}
        onMovePauseScheduled={handleMovePauseScheduled}
        onChangePauseDuration={onChangePauseDuration}
        onChangeIntervalPauseDuration={onChangeIntervalPauseDuration}
        onToggleFavorite={onToggleFavorite}
        onRename={onRename}
        onRemove={onRemove}
        dayEndPx={dayEndPx}
        resolveColumnPlacement={resolveColumnPlacement}
        resolveNowLinePlacement={resolveNowLinePlacement}
      />
    </div>
  );
}