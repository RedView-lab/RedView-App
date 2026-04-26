import ExcelJS from 'exceljs';

import { elapsedSecondsAtDistance } from '@/features/centerPanel/flyover/playback';
import { downloadExcel } from '@/features/fitPredictor/export/download';
import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor/types';
import { cumulativeRouteLengthsM, projectDistanceAlongRouteM } from '@/features/itineraryPanel/lib/route-distance';
import { kindLabel, poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type {
  Itinerary,
  PauseIntervalRow,
  PoiCategory,
  TimelineItem,
} from '@/features/itineraryPanel/types';
import { formatHHmm, getSunTimes } from '@/features/sunlight/lib/sun-calc';

interface RouteSample {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
}

type StopSource = 'timeline-pause' | 'favorite-poi' | 'interval';

interface CheckpointSeed {
  id: string;
  label: string;
  kind: TimelineItem['kind'] | 'intervalPause';
  typeLabel: string;
  distanceM: number;
  lat: number;
  lon: number;
  elevationM: number | null;
  poiCategory?: PoiCategory;
  stopMinutes: number;
  stopSource?: StopSource;
  generated: boolean;
  sortIndex: number;
}

interface SegmentMetrics {
  sectionDistanceM: number;
  ascentM: number;
  descentM: number;
  netGradientPct: number | null;
  sectionRideSeconds: number | null;
  cumulativeRideSeconds: number | null;
  avgSpeedKmh: number | null;
  avgPowerW: number | null;
}

interface ServiceFlags {
  water: boolean;
  food: boolean;
  sleep: boolean;
  mechanic: boolean;
}

interface ScheduledCheckpoint extends CheckpointSeed, SegmentMetrics {
  arrivalDate: Date | null;
  departureDate: Date | null;
  arrivalLabel: string;
  departureLabel: string;
  sunriseLabel: string;
  sunsetLabel: string;
  dayPhase: string;
  cumulativeStopMinutes: number;
  serviceFlags: ServiceFlags;
  serviceTags: string;
}

interface ServiceGapSummary {
  count: number;
  longestDistanceKm: number;
  longestRideLabel: string;
  fromLabel: string;
  toLabel: string;
}

const SHEET_NAME = 'Feuille de route';
const SERVICES_SHEET_NAME = 'Ravito';
const SUMMARY_SHEET_NAME = 'Résumé ultra';

const DARK_BG = 'FF111111';
const MID_BG = 'FF262626';
const ACCENT = 'FFB44D12';
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
  size: 11,
};
const SUBHEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FF111111' },
  size: 11,
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
  right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
};
const ZEBRA_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF7F7F7' },
};
const SUMMARY_LABEL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF2F2F2' },
};

function fill(argb: string): ExcelJS.Fill {
  return {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb },
  };
}

export async function exportRoadbookExcel(
  itinerary: Itinerary,
): Promise<{ fileName: string }> {
  const workbook = buildRoadbookWorkbook(itinerary);
  const baseName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'itinerary';
  const fileName = `${sanitizeFileName(baseName)}-feuille-de-route.xlsx`;
  await downloadExcel(workbook, fileName);
  return { fileName };
}

export function buildRoadbookWorkbook(itinerary: Itinerary): ExcelJS.Workbook {
  const route = collectRouteSamples(itinerary);
  const prediction = itinerary.prediction ?? null;
  const manualCheckpoints = collectTimelineCheckpoints(itinerary, route);
  const intervalCheckpoints = collectIntervalPauseCheckpoints(itinerary, route, prediction);
  const checkpoints = [...manualCheckpoints, ...intervalCheckpoints].sort(compareCheckpointSeeds);
  const schedule = buildSchedule(itinerary, route, checkpoints, prediction);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RedView';
  workbook.created = new Date();
  workbook.subject = 'Feuille de route ultra-cyclisme';
  workbook.title = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Feuille de route';

  buildRoadbookSheet(workbook, itinerary, schedule);
  buildServicesSheet(workbook, schedule);
  buildSummarySheet(workbook, itinerary, schedule, prediction);

  return workbook;
}

function buildRoadbookSheet(
  workbook: ExcelJS.Workbook,
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
): void {
  const sheet = workbook.addWorksheet(SHEET_NAME);
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itinéraire';
  const totalDistanceKm = ((schedule[schedule.length - 1]?.distanceM ?? 0) / 1000).toFixed(1);

  sheet.columns = [
    { header: '#', key: 'index', width: 5 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Nom', key: 'name', width: 28 },
    { header: 'Km total', key: 'distance', width: 10 },
    { header: 'Km section', key: 'sectionDistance', width: 11 },
    { header: 'D+ sec', key: 'ascent', width: 10 },
    { header: 'D- sec', key: 'descent', width: 10 },
    { header: 'Alt.', key: 'altitude', width: 9 },
    { header: 'Pente nette %', key: 'gradient', width: 12 },
    { header: 'Roulage sec', key: 'rideSection', width: 13 },
    { header: 'Roulage cumulé', key: 'rideTotal', width: 14 },
    { header: 'Pause prévue', key: 'plannedStop', width: 12 },
    { header: 'Pauses cumulées', key: 'stopTotal', width: 13 },
    { header: 'ETA arrivée', key: 'arrival', width: 17 },
    { header: 'Départ estimé', key: 'departure', width: 17 },
    { header: 'Vit. sec km/h', key: 'speed', width: 12 },
    { header: 'P moy W', key: 'power', width: 10 },
    { header: 'Jour/nuit', key: 'dayPhase', width: 11 },
    { header: 'Lever', key: 'sunrise', width: 9 },
    { header: 'Coucher', key: 'sunset', width: 9 },
    { header: 'Usage', key: 'tags', width: 24 },
  ];

  sheet.mergeCells('A1:U1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `${routeName}  •  ${totalDistanceKm} km`;
  titleCell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = fill(DARK_BG);
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 24;

  sheet.mergeCells('A2:U2');
  const subtitle = sheet.getCell('A2');
  subtitle.value = buildRoadbookSubtitle(itinerary, schedule);
  subtitle.font = { color: { argb: 'FFEAEAEA' }, size: 10 };
  subtitle.fill = fill(MID_BG);
  subtitle.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(2).height = 20;

  const headerRow = sheet.getRow(3);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(ACCENT);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });

  schedule.forEach((checkpoint, index) => {
    const row = sheet.addRow({
      index: index + 1,
      type: checkpoint.typeLabel,
      name: checkpoint.label,
      distance: formatDistanceKm(checkpoint.distanceM),
      sectionDistance: formatDistanceKm(checkpoint.sectionDistanceM),
      ascent: formatInteger(checkpoint.ascentM),
      descent: formatInteger(checkpoint.descentM),
      altitude: formatInteger(checkpoint.elevationM),
      gradient: formatSignedNumber(checkpoint.netGradientPct, 1),
      rideSection: formatDuration(checkpoint.sectionRideSeconds),
      rideTotal: formatDuration(checkpoint.cumulativeRideSeconds),
      plannedStop: formatMinutesAsDuration(checkpoint.stopMinutes),
      stopTotal: formatMinutesAsDuration(checkpoint.cumulativeStopMinutes),
      arrival: checkpoint.arrivalLabel,
      departure: checkpoint.departureLabel,
      speed: formatNumber(checkpoint.avgSpeedKmh, 1),
      power: formatInteger(checkpoint.avgPowerW),
      dayPhase: checkpoint.dayPhase,
      sunrise: checkpoint.sunriseLabel,
      sunset: checkpoint.sunsetLabel,
      tags: checkpoint.serviceTags,
    });

    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.getCell('C').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('U').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    if (index % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = ZEBRA_FILL;
      });
    }

    applyCheckpointRowStyle(row, checkpoint);
  });

  sheet.autoFilter = 'A3:U3';
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
}

function buildServicesSheet(
  workbook: ExcelJS.Workbook,
  schedule: ScheduledCheckpoint[],
): void {
  const sheet = workbook.addWorksheet(SERVICES_SHEET_NAME);
  const services = schedule.filter((checkpoint) => checkpoint.serviceTags.length > 0);

  sheet.columns = [
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Nom', key: 'name', width: 28 },
    { header: 'Km', key: 'distance', width: 10 },
    { header: 'ETA', key: 'arrival', width: 17 },
    { header: 'Départ', key: 'departure', width: 17 },
    { header: 'Stop prévu', key: 'stop', width: 12 },
    { header: 'Usage', key: 'usage', width: 22 },
    { header: 'Gap eau avant', key: 'waterPrev', width: 12 },
    { header: 'Gap eau après', key: 'waterNext', width: 12 },
    { header: 'Gap food avant', key: 'foodPrev', width: 13 },
    { header: 'Gap food après', key: 'foodNext', width: 13 },
    { header: 'Gap sommeil avant', key: 'sleepPrev', width: 15 },
    { header: 'Gap sommeil après', key: 'sleepNext', width: 15 },
    { header: 'Gap méca avant', key: 'mechPrev', width: 13 },
    { header: 'Gap méca après', key: 'mechNext', width: 13 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });

  services.forEach((checkpoint, index) => {
    const row = sheet.addRow({
      type: checkpoint.typeLabel,
      name: checkpoint.label,
      distance: formatDistanceKm(checkpoint.distanceM),
      arrival: checkpoint.arrivalLabel,
      departure: checkpoint.departureLabel,
      stop: formatMinutesAsDuration(checkpoint.stopMinutes),
      usage: checkpoint.serviceTags,
      waterPrev: formatDistanceKm(distanceSincePreviousService(services, index, 'water')),
      waterNext: formatDistanceKm(distanceToNextService(services, index, 'water')),
      foodPrev: formatDistanceKm(distanceSincePreviousService(services, index, 'food')),
      foodNext: formatDistanceKm(distanceToNextService(services, index, 'food')),
      sleepPrev: formatDistanceKm(distanceSincePreviousService(services, index, 'sleep')),
      sleepNext: formatDistanceKm(distanceToNextService(services, index, 'sleep')),
      mechPrev: formatDistanceKm(distanceSincePreviousService(services, index, 'mechanic')),
      mechNext: formatDistanceKm(distanceToNextService(services, index, 'mechanic')),
    });

    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.getCell('B').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('G').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    if (index % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = ZEBRA_FILL;
      });
    }
    applyCheckpointRowStyle(row, checkpoint);
  });

  sheet.autoFilter = 'A1:O1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
  prediction: PredictionResult | null,
): void {
  const sheet = workbook.addWorksheet(SUMMARY_SHEET_NAME);
  sheet.columns = [{ width: 28 }, { width: 24 }, { width: 28 }];

  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itinéraire';
  const totalDistanceM = schedule[schedule.length - 1]?.distanceM ?? 0;
  const totalStopMinutes = schedule.reduce((sum, checkpoint) => sum + checkpoint.stopMinutes, 0);
  const startLabel = buildScheduleStartLabel(itinerary);
  const finishLabel = schedule[schedule.length - 1]?.departureLabel || schedule[schedule.length - 1]?.arrivalLabel || '--';
  const waterSummary = summarizeServiceWindows(schedule, 'water');
  const foodSummary = summarizeServiceWindows(schedule, 'food');
  const sleepSummary = summarizeServiceWindows(schedule, 'sleep');
  const mechanicSummary = summarizeServiceWindows(schedule, 'mechanic');

  let rowNumber = 1;
  rowNumber = addSummarySection(sheet, rowNumber, 'Parcours');
  addSummaryPair(sheet, rowNumber++, 'Nom', routeName);
  addSummaryPair(sheet, rowNumber++, 'Distance totale', `${formatDistanceKm(totalDistanceM)} km`);
  addSummaryPair(sheet, rowNumber++, 'Dénivelé positif', `${formatInteger(itinerary.metrics?.ascentM ?? prediction?.elevation_gain_m)} m`);
  addSummaryPair(sheet, rowNumber++, 'Dénivelé négatif', `${formatInteger(itinerary.metrics?.descentM ?? prediction?.elevation_loss_m)} m`);
  addSummaryPair(sheet, rowNumber++, 'Part tarmac', formatPercent(itinerary.metrics?.tarmacPercent));
  addSummaryPair(sheet, rowNumber++, 'Part off-road', formatPercent(itinerary.metrics?.offroadPercent));
  addSummaryPair(sheet, rowNumber++, 'Points roadbook', schedule.length);
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Timing ultra');
  addSummaryPair(sheet, rowNumber++, 'Départ', startLabel);
  addSummaryPair(sheet, rowNumber++, 'Arrivée estimée', finishLabel);
  addSummaryPair(sheet, rowNumber++, 'Temps roulant FIT', formatDuration(prediction?.riding_time_s ?? null));
  addSummaryPair(sheet, rowNumber++, 'Temps pause FIT', formatDuration(prediction?.stop_time_s ?? null));
  addSummaryPair(sheet, rowNumber++, 'Pauses planifiées export', formatMinutesAsDuration(totalStopMinutes));
  addSummaryPair(sheet, rowNumber++, 'Temps total FIT', formatDuration(prediction?.total_time_s ?? null));
  addSummaryPair(sheet, rowNumber++, 'Vit. moyenne FIT', formatKmh(prediction?.avg_speed_kmh ?? null));
  addSummaryPair(sheet, rowNumber++, 'Incertitude haute', formatDuration(prediction?.total_time_high_s ?? null));
  addSummaryPair(sheet, rowNumber++, 'Incertitude basse', formatDuration(prediction?.total_time_low_s ?? null));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Ravito et sommeil');
  addSummaryPair(sheet, rowNumber++, 'Points eau', waterSummary.count);
  addSummaryPair(sheet, rowNumber++, 'Plus grand gap eau', formatGapSummary(waterSummary));
  addSummaryPair(sheet, rowNumber++, 'Points food', foodSummary.count);
  addSummaryPair(sheet, rowNumber++, 'Plus grand gap food', formatGapSummary(foodSummary));
  addSummaryPair(sheet, rowNumber++, 'Points sommeil', sleepSummary.count);
  addSummaryPair(sheet, rowNumber++, 'Plus grand gap sommeil', formatGapSummary(sleepSummary));
  addSummaryPair(sheet, rowNumber++, 'Points méca', mechanicSummary.count);
  addSummaryPair(sheet, rowNumber++, 'Plus grand gap méca', formatGapSummary(mechanicSummary));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Réglages pris en compte');
  addSummaryPair(sheet, rowNumber++, 'Date de départ', itinerary.rhythm.startDate ?? '--');
  addSummaryPair(sheet, rowNumber++, 'Heure de départ', itinerary.rhythm.startTime ?? '--');
  addSummaryPair(sheet, rowNumber++, 'Pauses POI favoris', itinerary.rhythm.pauseAtFavoritePois ? 'Oui' : 'Non');
  addSummaryPair(sheet, rowNumber++, 'Pauses intervalle', itinerary.rhythm.pauseEveryIntervalEnabled ? 'Oui' : 'Non');
  addSummaryPair(sheet, rowNumber++, 'Lignes intervalle', itinerary.rhythm.pauseIntervals.length);
  addSummaryPair(sheet, rowNumber++, 'Export généré le', new Date().toLocaleString('fr-FR'));
}

function addSummarySection(sheet: ExcelJS.Worksheet, rowNumber: number, title: string): number {
  sheet.mergeCells(rowNumber, 1, rowNumber, 3);
  const row = sheet.getRow(rowNumber);
  const cell = row.getCell(1);
  cell.value = title;
  cell.font = { ...HEADER_FONT, size: 12 };
  cell.fill = fill(ACCENT);
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 22;
  return rowNumber + 1;
}

function addSummaryPair(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  label: string,
  value: string | number,
): void {
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = label;
  row.getCell(2).value = value;
  row.getCell(1).font = SUBHEADER_FONT;
  row.getCell(1).fill = SUMMARY_LABEL_FILL;
  row.eachCell((cell) => {
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
}

function collectRouteSamples(itinerary: Itinerary): RouteSample[] {
  const points = itinerary.gpxRoute?.points;
  if (!points || points.length < 2) {
    throw new Error('La feuille de route Excel nécessite une trace active exploitable.');
  }

  const cumulativeLengths = cumulativeRouteLengthsM(points);
  return points.map((point, index) => ({
    lat: point.lat,
    lon: point.lon,
    distanceM:
      Number.isFinite(point.distanceM) && (point.distanceM as number) >= 0
        ? (point.distanceM as number)
        : cumulativeLengths[index] ?? 0,
    elevationM: Number.isFinite(point.elevationM) ? (point.elevationM as number) : null,
  }));
}

function collectTimelineCheckpoints(
  itinerary: Itinerary,
  route: RouteSample[],
): CheckpointSeed[] {
  const routePoints = route.map((point) => ({ lat: point.lat, lon: point.lon }));
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  const totalDistanceM = route[route.length - 1]?.distanceM ?? 0;
  const checkpoints: CheckpointSeed[] = [];

  for (let index = 0; index < itinerary.timeline.length; index += 1) {
    const item = itinerary.timeline[index]!;
    if (!isRoadbookTimelineItem(item)) continue;
    const sampled = resolveItemSample(item, route, routePoints, cumulativeLengths, totalDistanceM);
    if (!sampled) continue;

    checkpoints.push({
      id: item.id,
      label: item.label.trim() || defaultLabelForItem(item),
      kind: item.kind,
      typeLabel: kindLabel(item.kind, item.poiCategory),
      distanceM: sampled.distanceM,
      lat: sampled.lat,
      lon: sampled.lon,
      elevationM: sampled.elevationM,
      poiCategory: item.poiCategory,
      stopMinutes: plannedStopMinutesForItem(itinerary, item),
      stopSource: stopSourceForItem(itinerary, item),
      generated: false,
      sortIndex: index,
    });
  }

  return checkpoints;
}

function collectIntervalPauseCheckpoints(
  itinerary: Itinerary,
  route: RouteSample[],
  prediction: PredictionResult | null,
): CheckpointSeed[] {
  if (!itinerary.rhythm.pauseEveryIntervalEnabled || !prediction || prediction.points.length < 2) {
    return [];
  }

  const checkpoints: CheckpointSeed[] = [];
  const totalRideSeconds = prediction.riding_time_s;
  let sequence = 10_000;

  for (const intervalRow of itinerary.rhythm.pauseIntervals) {
    const stops = buildIntervalStopTimes(intervalRow, totalRideSeconds);
    for (let index = 0; index < stops.length; index += 1) {
      const elapsedSeconds = stops[index]!;
      const distanceM = distanceAtElapsedSeconds(prediction, elapsedSeconds);
      if (!Number.isFinite(distanceM)) continue;
      const sample = sampleRouteAtDistance(route, distanceM as number);
      checkpoints.push({
        id: `${intervalRow.id}::${index}`,
        label: `${intervalRow.label || 'Pause'} ${index + 1}`,
        kind: 'intervalPause',
        typeLabel: 'Pause intervalle',
        distanceM: distanceM as number,
        lat: sample.lat,
        lon: sample.lon,
        elevationM: sample.elevationM,
        stopMinutes: Math.max(0, intervalRow.durationMin),
        stopSource: 'interval',
        generated: true,
        sortIndex: sequence,
      });
      sequence += 1;
    }
  }

  return checkpoints;
}

function buildIntervalStopTimes(intervalRow: PauseIntervalRow, totalRideSeconds: number): number[] {
  const intervalSeconds = Math.max(0, intervalRow.intervalMin) * 60;
  if (intervalSeconds <= 0) return [];
  const stops: number[] = [];
  for (let elapsedSeconds = intervalSeconds; elapsedSeconds < totalRideSeconds; elapsedSeconds += intervalSeconds) {
    stops.push(elapsedSeconds);
  }
  return stops;
}

function buildSchedule(
  itinerary: Itinerary,
  route: RouteSample[],
  checkpoints: CheckpointSeed[],
  prediction: PredictionResult | null,
): ScheduledCheckpoint[] {
  const startReference = buildScheduleReference(itinerary);
  let cumulativeStopMinutes = 0;

  return checkpoints.map((checkpoint, index) => {
    const previous = checkpoints[index - 1] ?? null;
    const metrics = computeSegmentMetrics(route, prediction, previous?.distanceM ?? 0, checkpoint.distanceM);
    const arrivalDate = buildScheduleDate(
      startReference.reference,
      metrics.cumulativeRideSeconds,
      cumulativeStopMinutes,
    );
    const departureDate = buildScheduleDate(
      startReference.reference,
      metrics.cumulativeRideSeconds,
      cumulativeStopMinutes + checkpoint.stopMinutes,
    );
    const { sunriseLabel, sunsetLabel, dayPhase } = describeSunWindow(arrivalDate, checkpoint, startReference.hasRealDate);
    const scheduled: ScheduledCheckpoint = {
      ...checkpoint,
      ...metrics,
      arrivalDate,
      departureDate,
      arrivalLabel: formatScheduleDate(arrivalDate, startReference.reference, startReference.hasRealDate),
      departureLabel: formatScheduleDate(departureDate, startReference.reference, startReference.hasRealDate),
      sunriseLabel,
      sunsetLabel,
      dayPhase,
      cumulativeStopMinutes: cumulativeStopMinutes + checkpoint.stopMinutes,
      serviceFlags: classifyServices(checkpoint),
      serviceTags: buildServiceTagLabel(checkpoint),
    };
    cumulativeStopMinutes += checkpoint.stopMinutes;
    return scheduled;
  });
}

function computeSegmentMetrics(
  route: RouteSample[],
  prediction: PredictionResult | null,
  startDistanceM: number,
  endDistanceM: number,
): SegmentMetrics {
  const clampedStartM = Math.max(0, startDistanceM);
  const clampedEndM = Math.max(clampedStartM, endDistanceM);
  const sectionDistanceM = Math.max(0, clampedEndM - clampedStartM);
  const { ascentM, descentM, netGradientPct } = summarizeElevationBetween(route, clampedStartM, clampedEndM);
  const startElapsedS = elapsedSecondsAtDistance(prediction, clampedStartM, route[route.length - 1]?.distanceM ?? clampedEndM);
  const endElapsedS = elapsedSecondsAtDistance(prediction, clampedEndM, route[route.length - 1]?.distanceM ?? clampedEndM);
  const sectionRideSeconds =
    Number.isFinite(startElapsedS) && Number.isFinite(endElapsedS)
      ? Math.max(0, (endElapsedS as number) - (startElapsedS as number))
      : null;
  const cumulativeRideSeconds = Number.isFinite(endElapsedS) ? (endElapsedS as number) : null;
  const avgSpeedKmh =
    Number.isFinite(sectionRideSeconds) && (sectionRideSeconds as number) > 0
      ? (sectionDistanceM / (sectionRideSeconds as number)) * 3.6
      : null;

  return {
    sectionDistanceM,
    ascentM,
    descentM,
    netGradientPct,
    sectionRideSeconds,
    cumulativeRideSeconds,
    avgSpeedKmh,
    avgPowerW: averagePowerBetween(prediction, clampedStartM, clampedEndM),
  };
}

function summarizeElevationBetween(
  route: RouteSample[],
  startDistanceM: number,
  endDistanceM: number,
): Pick<SegmentMetrics, 'ascentM' | 'descentM' | 'netGradientPct'> {
  const start = sampleRouteAtDistance(route, startDistanceM);
  const end = sampleRouteAtDistance(route, endDistanceM);
  const samples: number[] = [];

  if (start.elevationM != null) samples.push(start.elevationM);
  for (const point of route) {
    if (point.distanceM <= startDistanceM || point.distanceM >= endDistanceM) continue;
    if (point.elevationM != null) samples.push(point.elevationM);
  }
  if (end.elevationM != null) samples.push(end.elevationM);

  let ascentM = 0;
  let descentM = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index]! - samples[index - 1]!;
    if (delta > 0) ascentM += delta;
    if (delta < 0) descentM += Math.abs(delta);
  }

  const netGradientPct =
    endDistanceM > startDistanceM && start.elevationM != null && end.elevationM != null
      ? ((end.elevationM - start.elevationM) / (endDistanceM - startDistanceM)) * 100
      : null;

  return {
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    netGradientPct,
  };
}

function averagePowerBetween(
  prediction: PredictionResult | null,
  startDistanceM: number,
  endDistanceM: number,
): number | null {
  const points = prediction?.points ?? [];
  if (points.length === 0 || endDistanceM <= startDistanceM) return null;

  const matching = points.filter(
    (point) => point.distance_m >= startDistanceM && point.distance_m <= endDistanceM && Number.isFinite(point.predicted_power_w),
  );
  if (matching.length === 0) return null;

  const total = matching.reduce((sum, point) => sum + point.predicted_power_w, 0);
  return total / matching.length;
}

function classifyServices(checkpoint: CheckpointSeed): ServiceFlags {
  const category = checkpoint.poiCategory;
  return {
    water: category != null && WATER_CATEGORIES.has(category),
    food: category != null && FOOD_CATEGORIES.has(category),
    sleep: category != null && SLEEP_CATEGORIES.has(category),
    mechanic: category != null && MECHANIC_CATEGORIES.has(category),
  };
}

const WATER_CATEGORIES = new Set<PoiCategory>([
  'fountains',
  'supermarkets',
  'gasStations',
  'bakeries',
  'cafes',
  'bars',
  'restaurants',
  'hotels',
  'refuges',
]);
const FOOD_CATEGORIES = new Set<PoiCategory>([
  'supermarkets',
  'gasStations',
  'bakeries',
  'fastFood',
  'cafes',
  'bars',
  'restaurants',
  'hotels',
  'refuges',
]);
const SLEEP_CATEGORIES = new Set<PoiCategory>(['hotels', 'refuges']);
const MECHANIC_CATEGORIES = new Set<PoiCategory>(['bikeShops', 'gasStations']);

function buildServiceTagLabel(checkpoint: CheckpointSeed): string {
  const tags: string[] = [];
  const services = classifyServices(checkpoint);
  if (checkpoint.kind === 'waypoint') tags.push('Contrôle');
  if (checkpoint.kind === 'pause' || checkpoint.kind === 'intervalPause') tags.push('Pause');
  if (services.water) tags.push('Eau');
  if (services.food) tags.push('Food');
  if (services.sleep) tags.push('Sommeil');
  if (services.mechanic) tags.push('Méca');
  if (checkpoint.stopMinutes >= 120 && !tags.includes('Sommeil')) tags.push('Sommeil');
  return tags.join(' · ');
}

function summarizeServiceWindows(
  schedule: ScheduledCheckpoint[],
  service: keyof ServiceFlags,
): ServiceGapSummary {
  const markers = schedule.filter((checkpoint) => checkpoint.serviceFlags[service]);
  let longestDistanceM = 0;
  let longestRideSeconds: number | null = null;
  let fromLabel = schedule[0]?.label ?? '--';
  let toLabel = schedule[schedule.length - 1]?.label ?? '--';

  let previous = schedule[0] ?? null;
  for (const marker of markers) {
    if (!previous) {
      previous = marker;
      continue;
    }
    const gapDistanceM = Math.max(0, marker.distanceM - previous.distanceM);
    const gapRideSeconds =
      Number.isFinite(marker.cumulativeRideSeconds) && Number.isFinite(previous.cumulativeRideSeconds)
        ? (marker.cumulativeRideSeconds as number) - (previous.cumulativeRideSeconds as number)
        : null;
    if (gapDistanceM > longestDistanceM) {
      longestDistanceM = gapDistanceM;
      longestRideSeconds = gapRideSeconds;
      fromLabel = previous.label;
      toLabel = marker.label;
    }
    previous = marker;
  }

  const lastMarker = markers[markers.length - 1] ?? schedule[0] ?? null;
  const finish = schedule[schedule.length - 1] ?? null;
  if (lastMarker && finish) {
    const finalGapM = Math.max(0, finish.distanceM - lastMarker.distanceM);
    const finalRideSeconds =
      Number.isFinite(finish.cumulativeRideSeconds) && Number.isFinite(lastMarker.cumulativeRideSeconds)
        ? (finish.cumulativeRideSeconds as number) - (lastMarker.cumulativeRideSeconds as number)
        : null;
    if (finalGapM > longestDistanceM) {
      longestDistanceM = finalGapM;
      longestRideSeconds = finalRideSeconds;
      fromLabel = lastMarker.label;
      toLabel = finish.label;
    }
  }

  return {
    count: markers.length,
    longestDistanceKm: longestDistanceM / 1000,
    longestRideLabel: formatDuration(longestRideSeconds),
    fromLabel,
    toLabel,
  };
}

function formatGapSummary(summary: ServiceGapSummary): string {
  if (summary.count === 0 || summary.longestDistanceKm <= 0) return '--';
  return `${summary.longestDistanceKm.toFixed(1)} km (${summary.longestRideLabel}) • ${summary.fromLabel} → ${summary.toLabel}`;
}

function distanceSincePreviousService(
  schedule: ScheduledCheckpoint[],
  index: number,
  service: keyof ServiceFlags,
): number | null {
  const current = schedule[index];
  if (!current?.serviceFlags[service]) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!schedule[cursor]!.serviceFlags[service]) continue;
    return current.distanceM - schedule[cursor]!.distanceM;
  }
  return current.distanceM;
}

function distanceToNextService(
  schedule: ScheduledCheckpoint[],
  index: number,
  service: keyof ServiceFlags,
): number | null {
  const current = schedule[index];
  if (!current?.serviceFlags[service]) return null;
  for (let cursor = index + 1; cursor < schedule.length; cursor += 1) {
    if (!schedule[cursor]!.serviceFlags[service]) continue;
    return schedule[cursor]!.distanceM - current.distanceM;
  }
  return null;
}

function applyCheckpointRowStyle(row: ExcelJS.Row, checkpoint: ScheduledCheckpoint): void {
  let rowFill: ExcelJS.Fill | null = null;
  if (checkpoint.kind === 'start') rowFill = fill('FFE8F3E8');
  else if (checkpoint.kind === 'end') rowFill = fill('FFE9EDF7');
  else if (checkpoint.kind === 'pause' || checkpoint.kind === 'intervalPause') rowFill = fill('FFFDEFD5');
  else if (checkpoint.serviceFlags.sleep) rowFill = fill('FFEDE3FF');
  else if (checkpoint.serviceFlags.food) rowFill = fill('FFFDE9DD');
  else if (checkpoint.serviceFlags.water) rowFill = fill('FFE3F0FF');

  if (rowFill) {
    row.eachCell((cell) => {
      cell.fill = rowFill as ExcelJS.Fill;
    });
  }

  if (checkpoint.kind === 'start' || checkpoint.kind === 'end') {
    row.font = { bold: true };
  }
}

function buildRoadbookSubtitle(itinerary: Itinerary, schedule: ScheduledCheckpoint[]): string {
  const start = buildScheduleStartLabel(itinerary);
  const plannedStops = schedule.reduce((sum, checkpoint) => sum + checkpoint.stopMinutes, 0);
  const finish = schedule[schedule.length - 1]?.departureLabel || schedule[schedule.length - 1]?.arrivalLabel || '--';
  return `Départ: ${start}  |  Arrivée estimée: ${finish}  |  Pauses export: ${formatMinutesAsDuration(plannedStops)}`;
}

function buildScheduleStartLabel(itinerary: Itinerary): string {
  const reference = buildScheduleReference(itinerary);
  if (!reference.reference) return '--';
  return formatScheduleDate(reference.reference, reference.reference, reference.hasRealDate);
}

function buildScheduleReference(itinerary: Itinerary): {
  reference: Date | null;
  hasRealDate: boolean;
} {
  const { startDate, startTime } = itinerary.rhythm;
  if (startDate && startTime) {
    const parsed = parseStartDateTime(startDate, startTime);
    if (parsed) return { reference: parsed, hasRealDate: true };
  }
  if (startTime) {
    const parsed = parseTimeReference(startTime);
    if (parsed) return { reference: parsed, hasRealDate: false };
  }
  return { reference: null, hasRealDate: false };
}

function buildScheduleDate(
  reference: Date | null,
  rideSeconds: number | null,
  stopMinutes: number,
): Date | null {
  if (!reference || !Number.isFinite(rideSeconds)) return null;
  return new Date(reference.getTime() + ((rideSeconds as number) + stopMinutes * 60) * 1000);
}

function describeSunWindow(
  date: Date | null,
  checkpoint: CheckpointSeed,
  hasRealDate: boolean,
): { sunriseLabel: string; sunsetLabel: string; dayPhase: string } {
  if (!date || !hasRealDate) {
    return { sunriseLabel: '--', sunsetLabel: '--', dayPhase: '--' };
  }
  const sunTimes = getSunTimes(date, checkpoint.lat, checkpoint.lon);
  const sunrise = sunTimes.sunrise;
  const sunset = sunTimes.sunset;
  const dayPhase =
    sunrise && sunset && date >= sunrise && date <= sunset
      ? 'Jour'
      : sunrise && sunset
        ? 'Nuit'
        : '--';
  return {
    sunriseLabel: formatHHmm(sunrise),
    sunsetLabel: formatHHmm(sunset),
    dayPhase,
  };
}

function formatScheduleDate(
  date: Date | null,
  reference: Date | null,
  hasRealDate: boolean,
): string {
  if (!date) return '--';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (hasRealDate) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month} ${hours}:${minutes}`;
  }
  if (!reference) return `${hours}:${minutes}`;
  const dayOffset = Math.floor((date.getTime() - reference.getTime()) / 86_400_000);
  return `J+${dayOffset} ${hours}:${minutes}`;
}

function parseStartDateTime(dateIso: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateIso.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  const hours = Number.parseInt(timeMatch[1], 10);
  const minutes = Number.parseInt(timeMatch[2], 10);
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimeReference(time: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return new Date(2000, 0, 1, hours, minutes, 0, 0);
}

function plannedStopMinutesForItem(itinerary: Itinerary, item: TimelineItem): number {
  if (item.kind === 'pause') return Math.max(0, item.durationMin ?? 0);
  if (
    item.kind === 'poi'
    && item.favorite
    && itinerary.rhythm.pauseAtFavoritePois
    && item.poiCategory
  ) {
    return Math.max(0, itinerary.rhythm.poiPauseDurations[item.poiCategory] ?? 0);
  }
  return 0;
}

function stopSourceForItem(itinerary: Itinerary, item: TimelineItem): StopSource | undefined {
  if (item.kind === 'pause' && (item.durationMin ?? 0) > 0) return 'timeline-pause';
  if (
    item.kind === 'poi'
    && item.favorite
    && itinerary.rhythm.pauseAtFavoritePois
    && item.poiCategory
    && (itinerary.rhythm.poiPauseDurations[item.poiCategory] ?? 0) > 0
  ) {
    return 'favorite-poi';
  }
  return undefined;
}

function isRoadbookTimelineItem(item: TimelineItem): boolean {
  if (item.visible === false && item.kind !== 'start' && item.kind !== 'end') return false;
  return item.kind === 'start'
    || item.kind === 'end'
    || item.kind === 'waypoint'
    || item.kind === 'poi'
    || item.kind === 'pause';
}

function resolveItemSample(
  item: TimelineItem,
  route: RouteSample[],
  routePoints: Array<{ lat: number; lon: number }>,
  cumulativeLengths: number[],
  totalDistanceM: number,
): RouteSample | null {
  let distanceM: number | null = Number.isFinite(item.distanceKm) ? (item.distanceKm as number) * 1000 : null;
  if (distanceM == null && Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
    distanceM = projectDistanceAlongRouteM(
      { lat: item.lat as number, lon: item.lon as number },
      routePoints,
      cumulativeLengths,
    );
  }
  if (item.kind === 'start') distanceM = 0;
  if (item.kind === 'end') distanceM = totalDistanceM;
  if (!Number.isFinite(distanceM)) return null;

  const sampled = sampleRouteAtDistance(route, Math.max(0, Math.min(totalDistanceM, distanceM as number)));
  return {
    ...sampled,
    lat: Number.isFinite(item.lat) ? (item.lat as number) : sampled.lat,
    lon: Number.isFinite(item.lon) ? (item.lon as number) : sampled.lon,
  };
}

function sampleRouteAtDistance(route: RouteSample[], distanceM: number): RouteSample {
  if (distanceM <= route[0]!.distanceM) return route[0]!;
  const last = route[route.length - 1]!;
  if (distanceM >= last.distanceM) return last;

  let lo = 0;
  let hi = route.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (route[mid]!.distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const start = route[lo]!;
  const end = route[hi]!;
  const span = end.distanceM - start.distanceM;
  if (span <= 0) return start;
  const t = (distanceM - start.distanceM) / span;
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t,
    distanceM,
    elevationM:
      start.elevationM != null && end.elevationM != null
        ? start.elevationM + (end.elevationM - start.elevationM) * t
        : start.elevationM ?? end.elevationM ?? null,
  };
}

function distanceAtElapsedSeconds(
  prediction: PredictionResult,
  elapsedSeconds: number,
): number | null {
  const points = prediction.points;
  if (points.length < 2) return null;
  if (elapsedSeconds <= points[0]!.elapsed_time_s) return points[0]!.distance_m;
  const last = points[points.length - 1]!;
  if (elapsedSeconds >= last.elapsed_time_s) return last.distance_m;

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid]!.elapsed_time_s <= elapsedSeconds) lo = mid;
    else hi = mid;
  }

  return interpolateDistance(points[lo]!, points[hi]!, elapsedSeconds);
}

function interpolateDistance(
  start: PredictionPoint,
  end: PredictionPoint,
  elapsedSeconds: number,
): number {
  const span = end.elapsed_time_s - start.elapsed_time_s;
  if (span <= 0) return start.distance_m;
  const t = (elapsedSeconds - start.elapsed_time_s) / span;
  return start.distance_m + (end.distance_m - start.distance_m) * t;
}

function compareCheckpointSeeds(left: CheckpointSeed, right: CheckpointSeed): number {
  const distanceDelta = left.distanceM - right.distanceM;
  if (Math.abs(distanceDelta) > 0.01) return distanceDelta;

  const kindRankDelta = rankCheckpoint(left) - rankCheckpoint(right);
  if (kindRankDelta !== 0) return kindRankDelta;
  return left.sortIndex - right.sortIndex;
}

function rankCheckpoint(checkpoint: CheckpointSeed): number {
  switch (checkpoint.kind) {
    case 'start':
      return 0;
    case 'waypoint':
      return 1;
    case 'poi':
      return 2;
    case 'pause':
      return 3;
    case 'intervalPause':
      return 4;
    case 'end':
      return 5;
    default:
      return 6;
  }
}

function defaultLabelForItem(item: TimelineItem): string {
  if (item.kind === 'poi' && item.poiCategory) return poiLabel(item.poiCategory);
  return kindLabel(item.kind, item.poiCategory);
}

function sanitizeFileName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase() || 'itinerary';
}

function buildColumnHeaders(columns: Partial<ExcelJS.Column>[]): string[] {
  return columns.map((column) => {
    const header = column.header;
    if (Array.isArray(header)) return String(header[0] ?? '');
    return String(header ?? '');
  });
}

function formatDuration(totalSeconds: number | null | undefined): string {
  if (!Number.isFinite(totalSeconds)) return '--';
  const safeSeconds = Math.max(0, Math.round(totalSeconds as number));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatMinutesAsDuration(totalMinutes: number | null | undefined): string {
  if (!Number.isFinite(totalMinutes)) return '--';
  return formatDuration((totalMinutes as number) * 60);
}

function formatInteger(value: number | null | undefined): string {
  return Number.isFinite(value) ? String(Math.round(value as number)) : '--';
}

function formatDistanceKm(distanceM: number | null | undefined): string {
  return Number.isFinite(distanceM) ? ((distanceM as number) / 1000).toFixed(1) : '--';
}

function formatNumber(value: number | null | undefined, digits: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : '--';
}

function formatSignedNumber(value: number | null | undefined, digits: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : '--';
}

function formatPercent(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Math.round(value as number)} %` : '--';
}

function formatKmh(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${(value as number).toFixed(1)} km/h` : '--';
}