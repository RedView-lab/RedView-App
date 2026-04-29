import ExcelJS from 'exceljs';

import type { PredictionResult } from '@/features/fitPredictor/types';

import {
  ANALYSIS_SHEET_NAME,
  DARK_BG,
  HEADER_FONT,
  ROUTE_POINTS_SHEET_NAME,
  SEGMENTS_SHEET_NAME,
  THIN_BORDER,
  fill,
} from './constants';
import { buildColumnHeaders } from './format';
import { secondsToExcelTime } from './sheetShared';
import type { RouteSample } from './types';

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