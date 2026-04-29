import ExcelJS from 'exceljs';

import type { PredictionResult } from '@/features/fitPredictor/types';
import { poiLabel } from '@/features/itineraryPanel/sections/timeline/KindBadge';
import type { Itinerary, PoiCategory } from '@/features/itineraryPanel/types';

import {
  ACCENT,
  DARK_BG,
  EDITABLE_FILL,
  HEADER_FONT,
  MID_BG,
  PARAMETERS_SHEET_NAME,
  SERVICES_SHEET_NAME,
  SHEET_NAME,
  THIN_BORDER,
  TIMELINE_SHEET_NAME,
  ZEBRA_FILL,
  fill,
} from './constants';
import {
  distanceSincePreviousService,
  distanceToNextService,
} from './checkpoints';
import { buildColumnHeaders } from './format';
import { buildRoadbookSubtitle } from './schedule';
import type { RouteSample, ScheduledCheckpoint } from './types';
import {
  addParamRow,
  addSummarySection,
  applyCheckpointRowStyle,
  buildEditableStartValue,
  nullableKm,
  secondsToExcelTime,
  START_CELL_REF,
  writeSimpleTable,
  yesNo,
} from './sheetShared';

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