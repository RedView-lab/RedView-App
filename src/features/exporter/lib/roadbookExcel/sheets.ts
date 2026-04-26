import ExcelJS from 'exceljs';

import type { PredictionResult } from '@/features/fitPredictor/types';
import { poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type { Itinerary, PoiCategory } from '@/features/itineraryPanel/types';

import {
  ACCENT,
  ANALYSIS_SHEET_NAME,
  DARK_BG,
  EDITABLE_FILL,
  HEADER_FONT,
  MID_BG,
  PARAMETERS_SHEET_NAME,
  ROUTE_POINTS_SHEET_NAME,
  SEGMENTS_SHEET_NAME,
  SERVICES_SHEET_NAME,
  SHEET_NAME,
  SUBHEADER_FONT,
  SUMMARY_LABEL_FILL,
  SUMMARY_SHEET_NAME,
  THIN_BORDER,
  TIMELINE_SHEET_NAME,
  ZEBRA_FILL,
  fill,
} from './constants';
import { distanceSincePreviousService, distanceToNextService, formatGapSummary, summarizeServiceWindows } from './checkpoints';
import {
  buildColumnHeaders,
  formatDistanceKm,
  formatDuration,
  formatInteger,
  formatKmh,
  formatMinutesAsDuration,
  formatPercent,
  parseStartDateTime,
  parseTimeReference,
} from './format';
import { buildRoadbookSubtitle, buildScheduleStartLabel } from './schedule';
import type { RouteSample, ScheduledCheckpoint } from './types';

const START_CELL_REF = `'${PARAMETERS_SHEET_NAME}'!$B$4`;

export function buildParametersSheet(
  workbook: ExcelJS.Workbook,
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
  route: RouteSample[],
  prediction: PredictionResult | null,
): void {
  const sheet = workbook.addWorksheet(PARAMETERS_SHEET_NAME);
  sheet.columns = [{ width: 28 }, { width: 24 }, { width: 24 }, { width: 22 }, { width: 18 }];

  sheet.mergeCells('A1:E1');
  const title = sheet.getCell('A1');
  title.value = 'Paramètres et export total RedView';
  title.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(DARK_BG);
  title.alignment = { horizontal: 'left', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  sheet.mergeCells('A2:E2');
  const note = sheet.getCell('A2');
  note.value = 'Cellules vertes = modifiables dans Excel pour recalibrer départ et pauses sans perdre les données exportées depuis la web app.';
  note.font = { color: { argb: 'FFEAEAEA' }, size: 10 };
  note.fill = fill(MID_BG);
  note.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  sheet.getRow(2).height = 22;

  let row = 4;
  row = addSummarySection(sheet, row, 'Général');
  addParamRow(sheet, row++, 'Nom itinéraire', itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itinéraire');
  addParamRow(sheet, row++, 'Départ Excel', buildEditableStartValue(itinerary), { editable: true, numFmt: 'dd/mm/yyyy hh:mm' });
  addParamRow(sheet, row++, 'Date départ app', itinerary.rhythm.startDate ?? '--');
  addParamRow(sheet, row++, 'Heure départ app', itinerary.rhythm.startTime ?? '--');
  addParamRow(sheet, row++, 'Distance totale km', (route[route.length - 1]?.distanceM ?? 0) / 1000, { numFmt: '0.0' });
  addParamRow(sheet, row++, 'Dénivelé positif m', itinerary.metrics?.ascentM ?? prediction?.elevation_gain_m ?? null, { numFmt: '0' });
  addParamRow(sheet, row++, 'Dénivelé négatif m', itinerary.metrics?.descentM ?? prediction?.elevation_loss_m ?? null, { numFmt: '0' });
  addParamRow(sheet, row++, 'Temps roulant FIT', secondsToExcelTime(prediction?.riding_time_s ?? null), { numFmt: '[h]:mm' });
  addParamRow(sheet, row++, 'Temps total FIT', secondsToExcelTime(prediction?.total_time_s ?? null), { numFmt: '[h]:mm' });
  addParamRow(sheet, row++, 'Vitesse moyenne km/h', prediction?.avg_speed_kmh ?? null, { numFmt: '0.0' });
  addParamRow(sheet, row++, 'Points roadbook', schedule.length, { numFmt: '0' });
  addParamRow(sheet, row++, 'Points trace', route.length, { numFmt: '0' });
  addParamRow(sheet, row++, 'Points analyse', prediction?.points.length ?? 0, { numFmt: '0' });

  row += 1;
  row = addSummarySection(sheet, row, 'Rythme');
  addParamRow(sheet, row++, 'Sexe', itinerary.rhythm.gender ?? 'default');
  addParamRow(sheet, row++, 'FTP W', itinerary.rhythm.ftp ?? null, { numFmt: '0' });
  addParamRow(sheet, row++, 'Poids système kg', itinerary.rhythm.systemWeightKg ?? null, { numFmt: '0.0' });
  addParamRow(sheet, row++, 'Pneus mm', itinerary.rhythm.tiresMm ?? null, { numFmt: '0' });
  addParamRow(sheet, row++, 'Utiliser météo', yesNo(itinerary.rhythm.useWeather));
  addParamRow(sheet, row++, 'Poids météo %', itinerary.rhythm.weatherWeight, { numFmt: '0' });
  addParamRow(sheet, row++, 'Utiliser surfaces', yesNo(itinerary.rhythm.useSurfaces));
  addParamRow(sheet, row++, 'Poids surfaces %', itinerary.rhythm.surfacesWeight, { numFmt: '0' });
  addParamRow(sheet, row++, 'Utiliser activités passées', yesNo(itinerary.rhythm.usePastActivities));

  row += 1;
  row = addSummarySection(sheet, row, 'Pauses');
  addParamRow(sheet, row++, 'Pauses POI favoris', yesNo(itinerary.rhythm.pauseAtFavoritePois));
  addParamRow(sheet, row++, 'Pauses intervalle', yesNo(itinerary.rhythm.pauseEveryIntervalEnabled));

  const poiCategories = Object.keys(itinerary.rhythm.poiPauseDurations) as PoiCategory[];
  writeSimpleTable(
    sheet,
    row,
    ['POI', 'Pause min', 'Recherche active'],
    poiCategories.map((category) => [
      poiLabel(category),
      itinerary.rhythm.poiPauseDurations[category],
      itinerary.poi[category].enabled ? 'Oui' : 'Non',
    ]),
    [20, 12, 16],
  );

  writeSimpleTable(
    sheet,
    4,
    ['Pause intervalle', 'Durée min', 'Toutes les min'],
    itinerary.rhythm.pauseIntervals.length > 0
      ? itinerary.rhythm.pauseIntervals.map((entry) => [entry.label, entry.durationMin, entry.intervalMin])
      : [['--', null, null]],
    [18, 12, 14],
    'D',
  );

  writeSimpleTable(
    sheet,
    row + poiCategories.length + 3,
    ['Routing', 'Valeur'],
    [
      ['Durée', itinerary.priorities.duration],
      ['Dénivelé', itinerary.priorities.elevation],
      ['Distance', itinerary.priorities.distance],
      ['Tranquillité', itinerary.priorities.tranquility],
      ['Road', itinerary.roadTypes.road],
      ['Gravel', itinerary.roadTypes.gravel],
      ['Singletrack', itinerary.roadTypes.singletrack],
      ['Offroad', itinerary.roadTypes.offroad],
      ['Bike lanes', itinerary.roadTypes.bikeLanes],
      ['Major roads', itinerary.roadTypes.majorRoads],
      ['Ferry', itinerary.roadTypes.ferry],
      ['Turns', itinerary.roadTypes.turns],
      ['Max slope %', itinerary.roadTypes.maxSlopePercent],
      ['Cities', itinerary.roadTypes.cities],
    ],
    [20, 18],
    'D',
  );

  sheet.views = [{ state: 'frozen', ySplit: 3 }];
}

export function buildRoadbookSheet(
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
    { header: 'Pause min', key: 'plannedStop', width: 11 },
    { header: 'Pauses cumulées', key: 'stopTotal', width: 13 },
    { header: 'ETA arrivée', key: 'arrival', width: 17 },
    { header: 'Départ estimé', key: 'departure', width: 17 },
    { header: 'Vit. sec km/h', key: 'speed', width: 12 },
    { header: 'P moy W', key: 'power', width: 10 },
    { header: 'Jour/nuit', key: 'dayPhase', width: 11 },
    { header: 'Lever', key: 'sunrise', width: 9 },
    { header: 'Coucher', key: 'sunset', width: 9 },
    { header: 'Usage', key: 'tags', width: 24 },
    { header: 'Ride sec raw', key: 'rideSectionRaw', width: 12, hidden: true },
    { header: 'Ride cum raw', key: 'rideTotalRaw', width: 12, hidden: true },
  ];

  sheet.mergeCells('A1:W1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `${routeName}  •  ${totalDistanceKm} km`;
  titleCell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = fill(DARK_BG);
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 24;

  sheet.mergeCells('A2:W2');
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
      distance: checkpoint.distanceM / 1000,
      sectionDistance: checkpoint.sectionDistanceM / 1000,
      ascent: checkpoint.ascentM,
      descent: checkpoint.descentM,
      altitude: checkpoint.elevationM,
      gradient: checkpoint.netGradientPct,
      rideSection: secondsToExcelTime(checkpoint.sectionRideSeconds),
      rideTotal: secondsToExcelTime(checkpoint.cumulativeRideSeconds),
      plannedStop: checkpoint.stopMinutes,
      speed: checkpoint.avgSpeedKmh,
      power: checkpoint.avgPowerW,
      dayPhase: checkpoint.dayPhase,
      sunrise: checkpoint.sunriseLabel,
      sunset: checkpoint.sunsetLabel,
      tags: checkpoint.serviceTags,
      rideSectionRaw: checkpoint.sectionRideSeconds,
      rideTotalRaw: checkpoint.cumulativeRideSeconds,
    });

    const rowNumber = row.number;
    row.getCell('M').value = {
      formula: `SUM($L$4:L${rowNumber})/1440`,
      result: checkpoint.cumulativeStopMinutes / 1440,
    };
    row.getCell('N').value = {
      formula: `IF(OR(${START_CELL_REF}="",K${rowNumber}=""),"",${START_CELL_REF}+K${rowNumber}+M${rowNumber})`,
      result: checkpoint.arrivalDate ?? undefined,
    };
    row.getCell('O').value = {
      formula: `IF(N${rowNumber}="","",N${rowNumber}+L${rowNumber}/1440)`,
      result: checkpoint.departureDate ?? undefined,
    };

    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.getCell('C').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('U').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('D').numFmt = '0.0';
    row.getCell('E').numFmt = '0.0';
    row.getCell('F').numFmt = '0';
    row.getCell('G').numFmt = '0';
    row.getCell('H').numFmt = '0';
    row.getCell('I').numFmt = '0.0';
    row.getCell('J').numFmt = '[h]:mm';
    row.getCell('K').numFmt = '[h]:mm';
    row.getCell('L').numFmt = '0';
    row.getCell('M').numFmt = '[h]:mm';
    row.getCell('N').numFmt = 'dd/mm hh:mm';
    row.getCell('O').numFmt = 'dd/mm hh:mm';
    row.getCell('P').numFmt = '0.0';
    row.getCell('Q').numFmt = '0';
    row.getCell('L').fill = EDITABLE_FILL;
    row.getCell('L').dataValidation = {
      type: 'whole',
      operator: 'between',
      allowBlank: true,
      formulae: [0, 1440],
      showErrorMessage: true,
      errorTitle: 'Pause invalide',
      error: 'Entre un nombre de minutes entre 0 et 1440.',
    };

    if (index % 2 === 1) {
      row.eachCell((cell) => {
        if (cell.address !== `L${rowNumber}`) {
          cell.fill = ZEBRA_FILL;
        }
      });
    }

    applyCheckpointRowStyle(row, checkpoint);
  });

  sheet.autoFilter = 'A3:U3';
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
}

export function buildServicesSheet(
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
    { header: 'Stop min', key: 'stop', width: 11 },
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
      distance: checkpoint.distanceM / 1000,
      arrival: checkpoint.arrivalLabel,
      departure: checkpoint.departureLabel,
      stop: checkpoint.stopMinutes,
      usage: checkpoint.serviceTags,
      waterPrev: nullableKm(distanceSincePreviousService(services, index, 'water')),
      waterNext: nullableKm(distanceToNextService(services, index, 'water')),
      foodPrev: nullableKm(distanceSincePreviousService(services, index, 'food')),
      foodNext: nullableKm(distanceToNextService(services, index, 'food')),
      sleepPrev: nullableKm(distanceSincePreviousService(services, index, 'sleep')),
      sleepNext: nullableKm(distanceToNextService(services, index, 'sleep')),
      mechPrev: nullableKm(distanceSincePreviousService(services, index, 'mechanic')),
      mechNext: nullableKm(distanceToNextService(services, index, 'mechanic')),
    });

    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.getCell('B').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('G').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('C').numFmt = '0.0';
    row.getCell('F').numFmt = '0';
    row.getCell('H').numFmt = '0.0';
    row.getCell('I').numFmt = '0.0';
    row.getCell('J').numFmt = '0.0';
    row.getCell('K').numFmt = '0.0';
    row.getCell('L').numFmt = '0.0';
    row.getCell('M').numFmt = '0.0';
    row.getCell('N').numFmt = '0.0';
    row.getCell('O').numFmt = '0.0';

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

export function buildTimelineSheet(
  workbook: ExcelJS.Workbook,
  itinerary: Itinerary,
  schedule: ScheduledCheckpoint[],
): void {
  const sheet = workbook.addWorksheet(TIMELINE_SHEET_NAME);
  sheet.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'ID', key: 'id', width: 16 },
    { header: 'Type', key: 'kind', width: 14 },
    { header: 'Nom', key: 'label', width: 28 },
    { header: 'Visible', key: 'visible', width: 10 },
    { header: 'Favori', key: 'favorite', width: 10 },
    { header: 'POI', key: 'poiCategory', width: 16 },
    { header: 'Distance km', key: 'distanceKm', width: 12 },
    { header: 'Durée min', key: 'durationMin', width: 11 },
    { header: 'Pause calc min', key: 'plannedStop', width: 13 },
    { header: 'Lat', key: 'lat', width: 13 },
    { header: 'Lon', key: 'lon', width: 13 },
    { header: 'ETA', key: 'arrival', width: 17 },
    { header: 'Départ', key: 'departure', width: 17 },
    { header: 'Tags', key: 'tags', width: 24 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });

  const scheduleById = new Map(schedule.map((checkpoint) => [checkpoint.id, checkpoint]));
  itinerary.timeline.forEach((item, index) => {
    const checkpoint = scheduleById.get(item.id);
    const row = sheet.addRow({
      index: index + 1,
      id: item.id,
      kind: item.kind,
      label: item.label,
      visible: item.visible === false ? 'Non' : 'Oui',
      favorite: item.favorite ? 'Oui' : 'Non',
      poiCategory: item.poiCategory ? poiLabel(item.poiCategory) : '',
      distanceKm: item.distanceKm,
      durationMin: item.durationMin ?? null,
      plannedStop: checkpoint?.stopMinutes ?? null,
      lat: item.lat ?? null,
      lon: item.lon ?? null,
      arrival: checkpoint?.arrivalLabel ?? '--',
      departure: checkpoint?.departureLabel ?? '--',
      tags: checkpoint?.serviceTags ?? '',
    });
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.getCell('D').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('O').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    row.getCell('H').numFmt = '0.0';
    row.getCell('I').numFmt = '0';
    row.getCell('J').numFmt = '0';
    row.getCell('K').numFmt = '0.000000';
    row.getCell('L').numFmt = '0.000000';
  });

  sheet.autoFilter = 'A1:O1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export function buildAnalysisSheet(
  workbook: ExcelJS.Workbook,
  prediction: PredictionResult | null,
): void {
  const sheet = workbook.addWorksheet(ANALYSIS_SHEET_NAME);
  if (!prediction || prediction.points.length === 0) {
    sheet.getCell('A1').value = 'Aucune prédiction disponible.';
    return;
  }

  sheet.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'Distance km', key: 'distanceKm', width: 11 },
    { header: 'Temps h', key: 'elapsedHours', width: 10 },
    { header: 'Temps cumulé', key: 'elapsedExcel', width: 12 },
    { header: 'Temps section', key: 'segmentExcel', width: 12 },
    { header: 'Vitesse km/h', key: 'speed', width: 12 },
    { header: 'Puissance W', key: 'power', width: 12 },
    { header: 'Altitude m', key: 'elevation', width: 10 },
    { header: 'Pente %', key: 'gradient', width: 10 },
    { header: 'Fatigue', key: 'fatigue', width: 10 },
    { header: 'Circadien', key: 'circadian', width: 10 },
    { header: 'Distance eff', key: 'distanceEff', width: 10 },
    { header: 'KNN conf', key: 'knn', width: 10 },
    { header: 'Speed low', key: 'speedLow', width: 10 },
    { header: 'Speed high', key: 'speedHigh', width: 10 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });

  prediction.points.forEach((point, index) => {
    const row = sheet.addRow({
      index: index + 1,
      distanceKm: point.distance_m / 1000,
      elapsedHours: point.elapsed_time_s / 3600,
      elapsedExcel: secondsToExcelTime(point.elapsed_time_s),
      segmentExcel: secondsToExcelTime(point.segment_time_s),
      speed: point.predicted_speed_kmh,
      power: point.predicted_power_w,
      elevation: point.elevation_m,
      gradient: point.gradient_pct,
      fatigue: point.fatigue_factor ?? null,
      circadian: point.circadian_factor ?? null,
      distanceEff: point.distance_eff_factor ?? null,
      knn: point.knn_confidence ?? null,
      speedLow: point.predicted_speed_low_kmh ?? null,
      speedHigh: point.predicted_speed_high_kmh ?? null,
    });
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    row.getCell('B').numFmt = '0.00';
    row.getCell('C').numFmt = '0.00';
    row.getCell('D').numFmt = '[h]:mm';
    row.getCell('E').numFmt = '[h]:mm';
    row.getCell('F').numFmt = '0.0';
    row.getCell('G').numFmt = '0';
    row.getCell('H').numFmt = '0';
    row.getCell('I').numFmt = '0.0';
    row.getCell('J').numFmt = '0.000';
    row.getCell('K').numFmt = '0.000';
    row.getCell('L').numFmt = '0.000';
    row.getCell('M').numFmt = '0.000';
    row.getCell('N').numFmt = '0.0';
    row.getCell('O').numFmt = '0.0';
  });

  sheet.autoFilter = 'A1:O1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export function buildSegmentsSheet(
  workbook: ExcelJS.Workbook,
  prediction: PredictionResult | null,
): void {
  const sheet = workbook.addWorksheet(SEGMENTS_SHEET_NAME);
  if (!prediction || prediction.segments.length === 0) {
    sheet.getCell('A1').value = 'Aucun segment de prédiction disponible.';
    return;
  }

  sheet.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Début km', key: 'startKm', width: 10 },
    { header: 'Fin km', key: 'endKm', width: 10 },
    { header: 'Distance km', key: 'distanceKm', width: 11 },
    { header: 'D+ m', key: 'gain', width: 9 },
    { header: 'D- m', key: 'loss', width: 9 },
    { header: 'Pente %', key: 'gradient', width: 10 },
    { header: 'Vitesse km/h', key: 'speed', width: 12 },
    { header: 'Temps', key: 'time', width: 11 },
    { header: 'VAM', key: 'vam', width: 10 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });

  prediction.segments.forEach((segment, index) => {
    const row = sheet.addRow({
      index: index + 1,
      type: segment.segment_type,
      startKm: segment.start_distance_m / 1000,
      endKm: segment.end_distance_m / 1000,
      distanceKm: segment.distance_m / 1000,
      gain: segment.elevation_gain_m,
      loss: segment.elevation_loss_m,
      gradient: segment.avg_gradient_pct,
      speed: segment.avg_speed_kmh,
      time: secondsToExcelTime(segment.time_s),
      vam: segment.vam_mh ?? null,
    });
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    row.getCell('B').alignment = { vertical: 'middle', horizontal: 'left' };
    row.getCell('C').numFmt = '0.0';
    row.getCell('D').numFmt = '0.0';
    row.getCell('E').numFmt = '0.0';
    row.getCell('F').numFmt = '0';
    row.getCell('G').numFmt = '0';
    row.getCell('H').numFmt = '0.0';
    row.getCell('I').numFmt = '0.0';
    row.getCell('J').numFmt = '[h]:mm';
    row.getCell('K').numFmt = '0';
  });

  sheet.autoFilter = 'A1:K1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export function buildRoutePointsSheet(
  workbook: ExcelJS.Workbook,
  route: RouteSample[],
): void {
  const sheet = workbook.addWorksheet(ROUTE_POINTS_SHEET_NAME);
  sheet.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'Distance km', key: 'distanceKm', width: 11 },
    { header: 'Altitude m', key: 'elevation', width: 10 },
    { header: 'Lat', key: 'lat', width: 13 },
    { header: 'Lon', key: 'lon', width: 13 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.values = buildColumnHeaders(sheet.columns);
  headerRow.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = THIN_BORDER;
  });

  route.forEach((point, index) => {
    const row = sheet.addRow({
      index: index + 1,
      distanceKm: point.distanceM / 1000,
      elevation: point.elevationM,
      lat: point.lat,
      lon: point.lon,
    });
    row.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    row.getCell('B').numFmt = '0.000';
    row.getCell('C').numFmt = '0';
    row.getCell('D').numFmt = '0.000000';
    row.getCell('E').numFmt = '0.000000';
  });

  sheet.autoFilter = 'A1:E1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export function buildSummarySheet(
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
  addParamRow(sheet, rowNumber++, 'Nom', routeName);
  addParamRow(sheet, rowNumber++, 'Distance totale', `${formatDistanceKm(totalDistanceM)} km`);
  addParamRow(sheet, rowNumber++, 'Dénivelé positif', `${formatInteger(itinerary.metrics?.ascentM ?? prediction?.elevation_gain_m)} m`);
  addParamRow(sheet, rowNumber++, 'Dénivelé négatif', `${formatInteger(itinerary.metrics?.descentM ?? prediction?.elevation_loss_m)} m`);
  addParamRow(sheet, rowNumber++, 'Part tarmac', formatPercent(itinerary.metrics?.tarmacPercent));
  addParamRow(sheet, rowNumber++, 'Part off-road', formatPercent(itinerary.metrics?.offroadPercent));
  addParamRow(sheet, rowNumber++, 'Points roadbook', schedule.length);
  addParamRow(sheet, rowNumber++, 'Feuilles exportées', 'Paramètres, Roadbook, Ravito, Timeline, Analyse, Segments, Trace');
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Timing ultra');
  addParamRow(sheet, rowNumber++, 'Départ', startLabel);
  addParamRow(sheet, rowNumber++, 'Arrivée estimée', finishLabel);
  addParamRow(sheet, rowNumber++, 'Temps roulant FIT', formatDuration(prediction?.riding_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Temps pause FIT', formatDuration(prediction?.stop_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Pauses planifiées export', formatMinutesAsDuration(totalStopMinutes));
  addParamRow(sheet, rowNumber++, 'Temps total FIT', formatDuration(prediction?.total_time_s ?? null));
  addParamRow(sheet, rowNumber++, 'Vit. moyenne FIT', formatKmh(prediction?.avg_speed_kmh ?? null));
  addParamRow(sheet, rowNumber++, 'Incertitude haute', formatDuration(prediction?.total_time_high_s ?? null));
  addParamRow(sheet, rowNumber++, 'Incertitude basse', formatDuration(prediction?.total_time_low_s ?? null));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Ravito et sommeil');
  addParamRow(sheet, rowNumber++, 'Points eau', waterSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap eau', formatGapSummary(waterSummary));
  addParamRow(sheet, rowNumber++, 'Points food', foodSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap food', formatGapSummary(foodSummary));
  addParamRow(sheet, rowNumber++, 'Points sommeil', sleepSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap sommeil', formatGapSummary(sleepSummary));
  addParamRow(sheet, rowNumber++, 'Points méca', mechanicSummary.count);
  addParamRow(sheet, rowNumber++, 'Plus grand gap méca', formatGapSummary(mechanicSummary));
  rowNumber += 1;

  rowNumber = addSummarySection(sheet, rowNumber, 'Réglages pris en compte');
  addParamRow(sheet, rowNumber++, 'Date de départ', itinerary.rhythm.startDate ?? '--');
  addParamRow(sheet, rowNumber++, 'Heure de départ', itinerary.rhythm.startTime ?? '--');
  addParamRow(sheet, rowNumber++, 'Pauses POI favoris', itinerary.rhythm.pauseAtFavoritePois ? 'Oui' : 'Non');
  addParamRow(sheet, rowNumber++, 'Pauses intervalle', itinerary.rhythm.pauseEveryIntervalEnabled ? 'Oui' : 'Non');
  addParamRow(sheet, rowNumber++, 'Lignes intervalle', itinerary.rhythm.pauseIntervals.length);
  addParamRow(sheet, rowNumber++, 'Export généré le', new Date().toLocaleString('fr-FR'));
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

function addParamRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  label: string,
  value: ExcelJS.CellValue,
  options?: { editable?: boolean; numFmt?: string },
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
  if (options?.numFmt) {
    row.getCell(2).numFmt = options.numFmt;
  }
  if (options?.editable) {
    row.getCell(2).fill = EDITABLE_FILL;
  }
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
      if (cell.address !== `L${row.number}`) {
        cell.fill = rowFill;
      }
    });
  }

  if (checkpoint.kind === 'start' || checkpoint.kind === 'end') {
    row.font = { bold: true };
  }
}

function writeSimpleTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  headers: string[],
  rows: Array<Array<string | number | null>>,
  widths: number[],
  startColumn: 'A' | 'D' = 'A',
): void {
  const baseColumn = startColumn === 'A' ? 1 : 4;
  const headerRow = sheet.getRow(startRow);

  headers.forEach((header, index) => {
    const cell = headerRow.getCell(baseColumn + index);
    cell.value = header;
    cell.font = HEADER_FONT;
    cell.fill = fill(DARK_BG);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
    sheet.getColumn(baseColumn + index).width = widths[index];
  });

  rows.forEach((values, rowOffset) => {
    const row = sheet.getRow(startRow + 1 + rowOffset);
    values.forEach((value, cellOffset) => {
      const cell = row.getCell(baseColumn + cellOffset);
      cell.value = value;
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: cellOffset === 0 ? 'left' : 'center', vertical: 'middle', wrapText: true };
    });
  });
}

function buildEditableStartValue(itinerary: Itinerary): Date | null {
  if (itinerary.rhythm.startDate && itinerary.rhythm.startTime) {
    return parseStartDateTime(itinerary.rhythm.startDate, itinerary.rhythm.startTime);
  }
  if (itinerary.rhythm.startTime) {
    return parseTimeReference(itinerary.rhythm.startTime);
  }
  return null;
}

function secondsToExcelTime(totalSeconds: number | null | undefined): number | null {
  if (!Number.isFinite(totalSeconds)) return null;
  return (totalSeconds as number) / 86400;
}

function nullableKm(distanceM: number | null): number | null {
  return Number.isFinite(distanceM) ? (distanceM as number) / 1000 : null;
}

function yesNo(value: boolean): string {
  return value ? 'Oui' : 'Non';
}